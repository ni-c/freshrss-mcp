import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ToolInputError } from './result.js';

/**
 * Why a host is only reachable from where the FreshRSS server itself stands:
 * `loopback` addresses the machine doing the fetching, `link-local` covers
 * 169.254/16 and fe80::/10 — the range that carries the cloud metadata service.
 */
export type InternalHostKind = 'loopback' | 'link-local';

/** How long a name gets to resolve before the check gives up on it. */
const DNS_TIMEOUT_MS = 3000;

/** Names resolved at once, so a large OPML does not open one lookup per feed. */
const DNS_CONCURRENCY = 8;

/**
 * How long the resolving half may take in total. An OPML document may name
 * thousands of hosts, and against a resolver that black-holes queries the
 * lookups alone would outlast any sane tool call — so once the budget is spent
 * the remaining names are treated like names that did not resolve.
 */
const DNS_BUDGET_MS = 10_000;

/**
 * Names for the cloud metadata service, which resolve to 169.254.169.254 on the
 * instance itself and nowhere else.
 *
 * Resolving them here would return nothing, so the address check never sees the
 * address they stand for — but the FreshRSS server's own resolver answers them
 * if it runs on that cloud, which is the whole point of the attack.
 */
const METADATA_NAMES = new Set([
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'instance-data.ec2.internal',
]);

/**
 * Classifies a `URL.hostname` that addresses the fetching host or its link-local
 * range, or returns null for anything routable.
 *
 * String matching alone does not do this job. `URL` canonicalises an
 * IPv4-mapped IPv6 literal into hex — `http://[::ffff:127.0.0.1]/` arrives here
 * as `[::ffff:7f00:1]`, and `http://[::ffff:169.254.169.254]/` as
 * `[::ffff:a9fe:a9fe]` — while every dual-stack client dials those as plain
 * 127.0.0.1 and 169.254.169.254. So each literal is reduced to its embedded
 * IPv4 address and compared numerically; only real names are matched as text.
 *
 * Private LAN ranges (10/8, 172.16/12, 192.168/16, fc00::/7) are deliberately
 * not listed: a self-hosted FreshRSS legitimately subscribes to feeds elsewhere
 * on its own network, and blocking that would break the normal case for the
 * people running this server.
 */
export function internalHostKind(hostname: string): InternalHostKind | null {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  if (METADATA_NAMES.has(host)) return 'link-local';

  const version = isIP(host);
  if (version === 4) return ipv4Kind(host.split('.').map(Number));
  if (version !== 6) return null;

  const groups = expandIpv6(host);
  if (groups === null) return null;
  const explicit = ipv6Kind(groups);
  if (explicit !== null) return explicit;
  const embedded = embeddedIpv4(groups);
  return embedded === null ? null : ipv4Kind(embedded);
}

/**
 * Refuses hostnames the FreshRSS server must not be pointed at.
 *
 * Every caller passes hosts that FreshRSS will fetch server-side, so the check
 * is the same wherever such a URL enters: `subscribe_feed` for a single feed,
 * `import_opml` for every `xmlUrl`/`htmlUrl` in the document.
 *
 * Literals are decided outright. A name is additionally resolved, because
 * nothing stops a DNS record from pointing at 127.0.0.1 or 169.254.169.254 —
 * a literal check alone would be a guard that any attacker-controlled domain
 * walks around. An unresolvable name is passed on: the FreshRSS server may sit
 * in a different network with its own resolver, and refusing what this process
 * cannot see would break those setups. That, and the rebinding window between
 * this lookup and the fetch FreshRSS makes, is why SECURITY.md describes the
 * DNS half as a barrier against the easy case, not a boundary.
 */
export async function assertRoutableHosts(hostnames: string[]): Promise<void> {
  const names = new Set<string>();
  for (const hostname of hostnames) {
    const host = bareHost(hostname);
    const kind = internalHostKind(host);
    if (kind !== null) throw refusal(host, kind);
    // A literal is already decided; only names are worth a lookup.
    if (isIP(host) === 0 && host !== '') names.add(host);
  }

  const pending = [...names];
  const deadline = Date.now() + DNS_BUDGET_MS;
  const workers = Array.from(
    { length: Math.min(DNS_CONCURRENCY, pending.length) },
    async () => {
      for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
        if (Date.now() > deadline) return;
        for (const address of await resolveQuietly(name)) {
          const kind = internalHostKind(address);
          if (kind !== null) throw refusal(`${name} (${address})`, kind);
        }
      }
    }
  );
  await Promise.all(workers);
}

function refusal(host: string, kind: InternalHostKind): ToolInputError {
  return new ToolInputError(
    `refusing to point FreshRSS at ${host}: that is a ${kind} address. FreshRSS ` +
      'fetches the URL itself, and loopback and link-local addresses are not feed ' +
      'sources — they address the server or its cloud metadata service. Use a ' +
      'routable URL.'
  );
}

async function resolveQuietly(name: string): Promise<string[]> {
  try {
    const entries = await Promise.race([
      lookup(name, { all: true, verbatim: true }),
      new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), DNS_TIMEOUT_MS).unref();
      }),
    ]);
    return entries === null ? [] : entries.map((entry) => entry.address);
  } catch {
    return [];
  }
}

function bareHost(hostname: string): string {
  return (
    hostname
      .toLowerCase()
      // URL.hostname keeps the brackets around an IPv6 literal, so a bare '::1'
      // would never match.
      .replace(/^\[|]$/g, '')
      // 'localhost.' is the same name as 'localhost' — the root label is what
      // makes it fully qualified, not a different host.
      .replace(/\.+$/, '')
  );
}

/** Expands an IPv6 literal into its eight 16-bit groups. */
function expandIpv6(address: string): number[] | null {
  let text = address;
  // A literal may end in dotted-quad notation (::ffff:127.0.0.1). Fold that tail
  // into the two hex groups it stands for so the rest of this is uniform.
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted !== null) {
    const [a = 0, b = 0, c = 0, d = 0] = (dotted[1] ?? '')
      .split('.')
      .map(Number);
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    text = `${text.slice(0, dotted.index)}:${high}:${low}`;
  }

  const [head = '', tail] = text.split('::');
  const left = head === '' ? [] : head.split(':');
  const right = tail === undefined ? null : tail === '' ? [] : tail.split(':');
  if (right === null) return toGroups(left);
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return toGroups([...left, ...Array<string>(missing).fill('0'), ...right]);
}

function toGroups(groups: string[]): number[] | null {
  if (groups.length !== 8) return null;
  const numbers = groups.map((group) => parseInt(group, 16));
  return numbers.some((value) => Number.isNaN(value)) ? null : numbers;
}

/**
 * Extracts the IPv4 address an IPv6 literal carries, for the prefixes whose
 * whole purpose is to stand in for one.
 */
function embeddedIpv4(groups: number[]): number[] | null {
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groups;
  const carriesIpv4 =
    // ::a.b.c.d (IPv4-compatible) and ::ffff:a.b.c.d (IPv4-mapped, RFC 4291).
    ((a | b | c | d | e) === 0 && (f === 0 || f === 0xffff)) ||
    // ::ffff:0:a.b.c.d — IPv4-translated (RFC 2765).
    ((a | b | c | d) === 0 && e === 0xffff && f === 0) ||
    // 64:ff9b::a.b.c.d — the well-known NAT64 prefix (RFC 6052).
    (a === 0x64 && b === 0xff9b && (c | d | e | f) === 0);
  return carriesIpv4 ? [g >> 8, g & 0xff, h >> 8, h & 0xff] : null;
}

function ipv4Kind(octets: number[]): InternalHostKind | null {
  const [a = 0, b = 0] = octets;
  // 0.0.0.0/8 ('this host', RFC 1122) and 127/8 both reach the fetching machine.
  if (a === 0 || a === 127) return 'loopback';
  // 169.254/16, which holds 169.254.169.254 — the AWS/GCP/Azure metadata service.
  if (a === 169 && b === 254) return 'link-local';
  return null;
}

function ipv6Kind(groups: number[]): InternalHostKind | null {
  if (groups.every((group) => group === 0)) return 'loopback'; // ::
  if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) {
    return 'loopback'; // ::1
  }
  if (((groups[0] ?? 0) & 0xffc0) === 0xfe80) return 'link-local'; // fe80::/10
  return null;
}
