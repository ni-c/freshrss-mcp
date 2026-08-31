import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  confirmationPrompt,
  setResourceKey,
  type ConfirmationStore,
} from '../confirm.js';

import { SLOW_REQUEST_TIMEOUT_MS, type FreshRssApi } from '../api.js';
import { assertRoutableHosts } from '../hosts.js';
import { redactOpmlCredentials, redactUrlCredentials } from '../redact.js';
import { errorResult, run, textResult, ToolInputError } from '../result.js';
import { UNTRUSTED_CONTENT_NOTE } from '../shape.js';

/** Characters of OPML returned to the model. */
const MAX_EXPORT_CHARS = 200_000;
/**
 * Characters of OPML accepted for import. FreshRSS reads at most 1 048 576 bytes
 * of the request body (`file_get_contents('php://input', …, 1048576)`) and
 * silently truncates the rest, which would arrive as malformed XML — so the
 * limit lives here, well below that.
 */
const MAX_IMPORT_CHARS = 900_000;

export function registerOpmlReadTools(
  server: McpServer,
  api: FreshRssApi
): void {
  server.registerTool(
    'export_opml',
    {
      title: 'Export OPML',
      description:
        'Exports all subscriptions as an OPML document — the portable backup format for ' +
        'feed readers. For a readable overview of the subscriptions use list_feeds instead.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(async () => {
        // HTTP-auth feeds are stored as https://user:pass@host/feed and the
        // export carries that verbatim in xmlUrl.
        const opml = redactOpmlCredentials(
          await api.getText('/subscription/export')
        );
        const truncated = opml.length > MAX_EXPORT_CHARS;
        return textResult(
          `${UNTRUSTED_CONTENT_NOTE}\n\n` +
            (truncated
              ? `${opml.slice(0, MAX_EXPORT_CHARS)}\n\n(truncated at ${MAX_EXPORT_CHARS} characters; ` +
                'use list_feeds for a complete overview of the subscriptions)'
              : opml)
        );
      })
  );
}

/**
 * Refuses an OPML document with a document type declaration.
 *
 * No XML is parsed in this process, so there is no XXE exposure *here* — but the
 * document is posted to FreshRSS, which parses it with libxml. A DOCTYPE is the
 * carrier for both an entity-expansion bomb (a few hundred bytes that expand to
 * gigabytes in the PHP worker) and an external-entity reference that would make
 * the FreshRSS host fetch a URL or read a local file. A legitimate OPML file
 * never needs one, and this server is the cheapest place to say no.
 */
function assertNoDoctype(opml: string): void {
  if (/<!(doctype|entity)\b/i.test(opml)) {
    throw new ToolInputError(
      'the OPML document contains a document type or entity declaration, which is ' +
        'refused: it is the delivery mechanism for XML entity-expansion and ' +
        'external-entity attacks against the FreshRSS server. Remove the ' +
        '<!DOCTYPE …> line; OPML does not need it.'
    );
  }
}

/** Hostnames named in the confirmation prompt before the rest is counted. */
const PROMPTED_HOSTS = 8;

/** The attribute names FreshRSS turns into a server-side fetch. */
const URL_ATTRIBUTES = new Set(['xmlurl', 'htmlurl']);

function malformed(what: string): ToolInputError {
  return new ToolInputError(
    `the OPML document is not well-formed XML: it has ${what}. The document is ` +
      'refused rather than guessed at, because the feed URLs it would subscribe ' +
      'to cannot be read reliably from a document that does not parse.'
  );
}

const isSpace = (ch: string): boolean =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function skipSpace(xml: string, from: number): number {
  let i = from;
  while (i < xml.length && isSpace(xml[i] as string)) i++;
  return i;
}

/**
 * Collects every `xmlUrl`/`htmlUrl` value in the document, by walking it the way
 * an XML parser does.
 *
 * Searching for the attribute with a regular expression is not good enough here,
 * and the gap is exploitable. A regex pairs quotes by looking at raw text, so a
 * literal `xmlUrl="` planted inside a *single-quoted* attribute value or inside
 * a comment makes it pair the wrong quotes: it reads a harmless decoy while
 * libxml — the parser that actually reads this document on the FreshRSS side —
 * reads the real attribute next to it, and the check would be inspecting a URL
 * that never gets fetched while the one that does goes unseen.
 *
 * Walking from the first character keeps the two in step, because the walk
 * always knows whether it is inside a comment, a CDATA section or a quoted
 * value. Anything that does not scan as well-formed markup is refused rather
 * than guessed at.
 */
function urlAttributes(opml: string): UrlAttribute[] {
  const found: UrlAttribute[] = [];
  let i = 0;

  while (i < opml.length) {
    const tag = opml.indexOf('<', i);
    if (tag === -1) break;
    i = tag + 1;

    if (opml.startsWith('!--', i)) {
      const end = opml.indexOf('-->', i + 3);
      if (end === -1) throw malformed('an unterminated comment');
      i = end + 3;
      continue;
    }
    if (opml.startsWith('![CDATA[', i)) {
      const end = opml.indexOf(']]>', i + 8);
      if (end === -1) throw malformed('an unterminated CDATA section');
      i = end + 3;
      continue;
    }
    if (opml.startsWith('?', i)) {
      const end = opml.indexOf('?>', i + 1);
      if (end === -1) throw malformed('an unterminated processing instruction');
      i = end + 2;
      continue;
    }
    // A document type declaration is refused before this runs, so nothing else
    // starting with '!' belongs in an OPML file.
    if (opml.startsWith('!', i)) throw malformed('an unexpected declaration');
    if (opml.startsWith('/', i)) {
      const end = opml.indexOf('>', i);
      if (end === -1) throw malformed('an unterminated end tag');
      i = end + 1;
      continue;
    }

    i = readAttributes(opml, i, found);
  }
  return found;
}

/** One `xmlUrl`/`htmlUrl`, with the span its raw value occupies in the document. */
interface UrlAttribute {
  attribute: string;
  value: string;
  start: number;
  end: number;
}

/** Reads a start tag from just after its `<`, and returns the index behind it. */
function readAttributes(
  opml: string,
  from: number,
  found: UrlAttribute[]
): number {
  let i = from;
  while (i < opml.length && isNameChar(opml[i] as string)) i++;
  if (i === from) throw malformed('a "<" that starts no tag');

  for (;;) {
    i = skipSpace(opml, i);
    if (i >= opml.length) throw malformed('an unterminated start tag');
    if (opml[i] === '>') return i + 1;
    if (opml[i] === '/') {
      if (opml[i + 1] !== '>') throw malformed('a stray "/" inside a tag');
      return i + 2;
    }

    const nameStart = i;
    while (i < opml.length && isNameChar(opml[i] as string)) i++;
    const name = opml.slice(nameStart, i);
    if (name === '') throw malformed('an unreadable attribute name');

    i = skipSpace(opml, i);
    if (opml[i] !== '=')
      throw malformed(`the attribute ${name} without a value`);
    i = skipSpace(opml, i + 1);

    const quote = opml[i];
    if (quote !== '"' && quote !== "'") {
      throw malformed(`an unquoted value for the attribute ${name}`);
    }
    const end = opml.indexOf(quote, i + 1);
    if (end === -1) {
      throw malformed(`an unterminated value for the attribute ${name}`);
    }

    // On the local name, so a namespace prefix does not hide the attribute:
    // libxml reports `o:xmlUrl` with the local name `xmlUrl`.
    const attribute = (name.split(':').pop() as string).toLowerCase();
    if (URL_ATTRIBUTES.has(attribute)) {
      found.push({
        attribute,
        value: opml.slice(i + 1, end),
        start: i + 1,
        end,
      });
    }
    i = end + 1;
  }
}

function isNameChar(ch: string): boolean {
  return ch !== '=' && ch !== '/' && ch !== '>' && !isSpace(ch);
}

/**
 * Resolves the five predefined XML entities and numeric character references.
 *
 * libxml decodes these before FreshRSS ever sees the URL, so a check reading the
 * raw attribute would be looking at a different string than the one that gets
 * fetched. A document type declaration is refused earlier, so this is the whole
 * set of entities that can appear.
 */
function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, body: string) => {
      const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
      };
      const lower = body.toLowerCase();
      const replacement = named[lower];
      if (replacement !== undefined) return replacement;
      const code = lower.startsWith('#x')
        ? parseInt(lower.slice(2), 16)
        : Number(lower.slice(1));
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }
  );
}

/**
 * Refuses an OPML document that would point FreshRSS at its own loopback or at
 * the link-local range, and reports the hosts it does subscribe to.
 *
 * `/subscription/import` subscribes to every `xmlUrl` in the document and
 * fetches it server-side — the identical capability `subscribe_feed` guards,
 * reached through a second door. `htmlUrl` is checked too: FreshRSS fetches the
 * site link for the favicon.
 */
async function assertOutlineTargets(
  opml: string
): Promise<{ hosts: string[]; document: string }> {
  const hosts = new Set<string>();
  const pieces: string[] = [];
  let copied = 0;

  for (const { attribute, value, start, end } of urlAttributes(opml)) {
    const target = fetchTarget(attribute, decodeXmlEntities(value).trim());
    if (target === null) continue;
    hosts.add(target.hostname);
    // Write the URL that was checked back into the document, the way
    // subscribe_feed hands quickadd `parsed.toString()` rather than the string
    // it was given. Otherwise the check reads one thing and FreshRSS fetches
    // another: `http://ok.example.com\@127.0.0.1/` has the host
    // `ok.example.com` for a URL parser and `127.0.0.1` for curl.
    pieces.push(opml.slice(copied, start), escapeXml(target.toString()));
    copied = end;
  }
  pieces.push(opml.slice(copied));

  const found = [...hosts];
  await assertRoutableHosts(found);
  return { hosts: found, document: pieces.join('') };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Returns the URL FreshRSS would fetch for one attribute value, or null for a
 * value that names no host at all.
 *
 * A relative or empty value is left alone: there is no base URL in an OPML
 * import, so it addresses nothing and real exports do contain them. A
 * protocol-relative `//host/feed` does name a host, and a scheme other than
 * http/https is refused outright — `file://` and friends would have the
 * FreshRSS server read from its own disk rather than fetch a feed.
 *
 * `feed://` is refused with the rest, which is what `subscribe_feed` does with
 * it too. Reading it as the `http://` URL it conventionally stands for would
 * quietly downgrade a feed that is served over https, and guessing `https://`
 * would break the ones that are not — so the document says which one it means
 * or it does not get imported.
 */
function fetchTarget(attribute: string, value: string): URL | null {
  if (value === '') return null;
  const name = attribute === 'htmlurl' ? 'htmlUrl' : 'xmlUrl';

  let parsed: URL;
  try {
    parsed = new URL(value.startsWith('//') ? `http:${value}` : value);
  } catch {
    // No scheme and no authority: a relative value, which FreshRSS cannot
    // resolve into a request either.
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolInputError(
      `the OPML document has a ${name} with the scheme ${parsed.protocol} — only ` +
        'http:// and https:// feeds can be imported. A file:// or similar URL would ' +
        'make the FreshRSS server read from its own disk instead of fetching a feed: ' +
        redactUrlCredentials(value.slice(0, 200))
    );
  }
  return parsed;
}

/**
 * Makes the document's encoding declaration agree with the bytes it is sent as.
 *
 * The body goes out as UTF-8, but libxml on the FreshRSS side believes the
 * declaration over the bytes. `<?xml version="1.0" encoding="UTF-7"?>` makes it
 * read `+AHg-mlUrl="http://127.0.0.1/"` as `xmlUrl="http://127.0.0.1/"` — an
 * attribute this check, reading the same document as text, never sees under that
 * name, so the URL would be fetched without ever having been looked at. The same
 * trick hides a `<!DOCTYPE>` from the declaration check above it.
 *
 * Rewriting the declaration is what keeps both sides reading the same
 * characters: whatever escapes the document then contains stay literal text.
 * It also spares a document that declares ISO-8859-1 from turning its own feed
 * titles into mojibake — the same disagreement, without the teeth.
 */
function withUtf8Declaration(opml: string): string {
  const body = opml.startsWith('\ufeff') ? opml.slice(1) : opml;
  if (!body.startsWith('<?xml')) return body;

  const end = body.indexOf('?>');
  if (end === -1) throw malformed('an unterminated XML declaration');
  const declaration = body
    .slice(0, end)
    .replace(/\bencoding\s*=\s*("[^"]*"|'[^']*')/i, 'encoding="UTF-8"');
  return declaration + body.slice(end);
}

function describeHosts(hosts: string[]): string {
  if (hosts.length === 0) return 'no feed URLs';
  const named = hosts.slice(0, PROMPTED_HOSTS).join(', ');
  const rest = hosts.length - PROMPTED_HOSTS;
  return rest > 0
    ? `feeds on ${named} and ${rest} more host(s)`
    : `feeds on ${named}`;
}

export function registerOpmlWriteTools(
  server: McpServer,
  api: FreshRssApi,
  confirmations: ConfirmationStore
): void {
  server.registerTool(
    'import_opml',
    {
      title: 'Import OPML',
      description:
        'Subscribes to every feed in an OPML document, creating the categories it names, ' +
        'and then refreshes all feeds — which can take minutes on a large file. There is ' +
        'no bulk undo; every feed would have to be removed individually. Two-step: the ' +
        'first call returns a confirmation token, the second call with that token performs ' +
        'the import.',
      inputSchema: z.object({
        opml: z.string().min(1).describe('OPML document'),
        confirm_token: z
          .string()
          .optional()
          .describe('Token from the first call of this tool'),
      }),
      annotations: { destructiveHint: true },
    },
    async ({ opml, confirm_token }) =>
      run(async () => {
        if (opml.length > MAX_IMPORT_CHARS) {
          throw new ToolInputError(
            `the OPML document is too large (${opml.length} characters, limit ${MAX_IMPORT_CHARS}). ` +
              'Split it or import it through the FreshRSS web interface.'
          );
        }
        // The encoding declaration first: until it agrees with the bytes this
        // sends, every check below reads different characters than FreshRSS will.
        const declared = withUtf8Declaration(opml);
        assertNoDoctype(declared);
        // Before the token, not after it: a document that will be refused must
        // not first be confirmed, and the prompt names the hosts it found.
        const { hosts, document } = await assertOutlineTargets(declared);
        // The token is bound to the exact document: confirming a small OPML must
        // not authorise importing a different, larger one.
        const resource = setResourceKey('import_opml', [opml]);

        if (!confirmations.consume(resource, confirm_token)) {
          if (confirm_token !== undefined) {
            return errorResult(
              'The confirmation token is invalid, expired or was issued for a different ' +
                'document. Call import_opml without a token to get a new one.'
            );
          }
          const outlines = (document.match(/<outline\b/gi) ?? []).length;
          return textResult(
            confirmationPrompt(
              `import an OPML document with ${outlines} outline element(s), subscribing to ` +
                `${describeHosts(hosts)} and refreshing all feeds afterwards`,
              confirmations.issue(resource),
              confirmations.ttlMinutes
            )
          );
        }

        // The checked document, not the one that came in: the two differ exactly
        // where a URL parser and FreshRSS's fetcher would have disagreed.
        const body = await api.postRaw(
          '/subscription/import',
          document,
          'application/xml',
          SLOW_REQUEST_TIMEOUT_MS
        );
        if (body.trim() !== 'OK') {
          return errorResult(
            `FreshRSS did not confirm the import; it answered: ${body.trim().slice(0, 200)}`
          );
        }
        return textResult(
          'OPML imported. Call list_feeds to see the resulting subscriptions.'
        );
      })
  );
}
