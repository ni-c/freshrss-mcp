import { internalHostsAmong, type InternalHostKind } from 'mcp-internal-hosts';

import { ToolInputError } from './result.js';

/**
 * Refuses hostnames the FreshRSS server must not be pointed at.
 *
 * Every caller passes hosts that FreshRSS will fetch server-side, so the check
 * is the same wherever such a URL enters: `subscribe_feed` for a single feed,
 * `import_opml` for every `xmlUrl`/`htmlUrl` in the document.
 *
 * The classification and the resolving live in `mcp-internal-hosts`; what stays
 * here is the decision, which the library deliberately does not make — it
 * reports which hosts are internal and leaves refusing, warning or dropping to
 * the caller. This one refuses, and says so in FreshRSS's own terms.
 *
 * `stopAtFirst` is why this needs 0.2.0 of the library rather than 0.1.0. An
 * OPML document may name thousands of feeds; if the first points at 127.0.0.1
 * the answer is already known, and resolving the rest would spend the whole
 * ten-second budget to reach the same refusal.
 *
 * An unresolvable name is passed on: the FreshRSS server may sit in a different
 * network with its own resolver, and refusing what this process cannot see
 * would break those setups. That, and the rebinding window between this lookup
 * and the fetch FreshRSS makes, is why SECURITY.md describes the DNS half as a
 * barrier against the easy case, not a boundary.
 */
export async function assertRoutableHosts(hostnames: string[]): Promise<void> {
  // Deduplicated here rather than in the library: an OPML document routinely
  // names the same host for dozens of feeds, and the library takes the list it
  // is given. One lookup per distinct name, not per entry.
  const found = await internalHostsAmong([...new Set(hostnames)], {
    stopAtFirst: true,
  });
  for (const [, { address, kind }] of found) throw refusal(address, kind);
}

function refusal(host: string, kind: InternalHostKind): ToolInputError {
  return new ToolInputError(
    `refusing to point FreshRSS at ${host}: that is a ${kind} address. FreshRSS ` +
      'fetches the URL itself, and loopback and link-local addresses are not feed ' +
      'sources — they address the server or its cloud metadata service. Use a ' +
      'routable URL.'
  );
}
