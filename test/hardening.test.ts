/**
 * Regression tests for the findings of the pre-release security audit.
 *
 * Every `it` here corresponds to a defect that was actually present, so a
 * failure means a specific hardening measure was removed rather than a style
 * preference being violated. The audit note is quoted in each case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { loadConfig } from '../src/config.js';
import { redactOpmlCredentials, redactUrlCredentials } from '../src/redact.js';
import { jsonResult, ResultTooLargeError } from '../src/result.js';
import {
  htmlToText,
  Notes,
  shapeEntry,
  shapeSubscription,
  UNTRUSTED_CONTENT_NOTE,
} from '../src/shape.js';
import { assertTagName, itemIdToDecimal } from '../src/streams.js';
import { emptyResultHint } from '../src/tools/articles.js';
import {
  connect,
  dataOf,
  rawEntry,
  stubFreshRss,
  textOf,
  type Routes,
} from './harness.js';

/** Stubs the routes, connects, and makes one call. */
async function call(
  routes: Routes,
  name: string,
  args: Record<string, unknown> = {}
): Promise<CallToolResult> {
  stubFreshRss(routes);
  const client = await connect();
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('untrusted-data marker', () => {
  // The marker was added only on the path that returns article text, so a
  // title-only item shipped fully attacker-controlled fields unlabelled.
  it('is added for an entry with no content at all', () => {
    const notes = new Notes();
    shapeEntry(
      rawEntry({ summary: undefined, content: undefined }),
      (id) => id,
      { includeContent: true, maxContentChars: 500, totalContentBudget: 500 },
      { left: 500 },
      notes
    );
    expect(notes.list()).toContain(UNTRUSTED_CONTENT_NOTE);
  });

  it('is added even when the content budget is already exhausted', () => {
    const notes = new Notes();
    const shaped = shapeEntry(
      rawEntry(),
      (id) => id,
      { includeContent: true, maxContentChars: 500, totalContentBudget: 0 },
      { left: 0 },
      notes
    );
    expect(shaped.contentOmitted).toBe('budget');
    expect(notes.list()).toContain(UNTRUSTED_CONTENT_NOTE);
  });

  it('reaches the tool result for a listing of title-only articles', async () => {
    const result = await call(
      {
        '/stream/contents/user/-/state/com.google/reading-list': JSON.stringify(
          {
            items: [rawEntry({ summary: undefined, content: undefined })],
          }
        ),
      },
      'list_articles'
    );
    expect(dataOf(result).notes).toContain(UNTRUSTED_CONTENT_NOTE);
  });
});

describe('credential redaction in feed URLs', () => {
  it('replaces the userinfo part', () => {
    expect(redactUrlCredentials('https://user:pw@host.example/feed')).toBe(
      'https://***@host.example/feed'
    );
  });

  it('leaves a URL without credentials byte-identical', () => {
    const url = 'https://host.example/feed?a=1&b=2#x';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  it('does not treat an @ later in the path as userinfo', () => {
    const url = 'https://host.example/users/@alice/feed';
    expect(redactUrlCredentials(url)).toBe(url);
  });

  // Userinfo ends at the *last* @ before the path, and FreshRSS does not
  // percent-encode the password it stores — so a password containing an @ used
  // to be cut in half, with the second half published as part of the host.
  it.each([
    ['https://alice:S3cr3t@Pass@rss.example/feed', 'Pass'],
    ['https://alice:p@ssw0rd@rss.example/feed', 'ssw0rd'],
    ['https://a@b@c@d@rss.example/feed', 'c@d'],
  ])('redacts a password containing an @ (%s)', (url, leaked) => {
    const redacted = redactUrlCredentials(url);
    expect(redacted).toBe('https://***@rss.example/feed');
    expect(redacted).not.toContain(leaked);
  });

  it('redacts a password containing an @ in the OPML export too', () => {
    const opml =
      '<opml><body><outline xmlUrl="https://sub:s3@cret@paid.example/rss"/></body></opml>';
    const redacted = redactOpmlCredentials(opml);
    expect(redacted).not.toContain('cret');
    expect(redacted).toContain('xmlUrl="https://***@paid.example/rss"');
  });

  it('redacts feedUrl and siteUrl in a shaped subscription', () => {
    const shaped = shapeSubscription(
      {
        id: 'feed/7',
        title: 'Paid feed',
        url: 'https://sub:s3cret@paid.example/rss',
        htmlUrl: 'https://sub:s3cret@paid.example/',
      },
      new Map()
    );
    expect(JSON.stringify(shaped)).not.toContain('s3cret');
    expect(shaped.feedUrl).toBe('https://***@paid.example/rss');
  });

  it('redacts xmlUrl in an OPML document but keeps the rest intact', () => {
    const opml =
      '<opml><body><outline text="P" xmlUrl="https://sub:s3cret@paid.example/rss?a=1&amp;b=2" htmlUrl="https://paid.example/"/></body></opml>';
    const redacted = redactOpmlCredentials(opml);
    expect(redacted).not.toContain('s3cret');
    expect(redacted).toContain(
      'xmlUrl="https://***@paid.example/rss?a=1&amp;b=2"'
    );
    expect(redacted).toContain('htmlUrl="https://paid.example/"');
  });

  it('redacts the OPML export end to end', async () => {
    const result = await call(
      {
        '/subscription/export':
          '<opml><body><outline xmlUrl="https://sub:s3cret@paid.example/rss"/></body></opml>',
      },
      'export_opml'
    );
    expect(textOf(result)).not.toContain('s3cret');
  });

  it('redacts feedUrl through list_feeds', async () => {
    const result = await call(
      {
        '/subscription/list': JSON.stringify({
          subscriptions: [
            {
              id: 'feed/7',
              title: 'Paid',
              url: 'https://sub:s3cret@paid.example/rss',
            },
          ],
        }),
        '/unread-count': JSON.stringify({ max: 0, unreadcounts: [] }),
      },
      'list_feeds'
    );
    expect(textOf(result)).not.toContain('s3cret');
  });
});

describe('path guards', () => {
  // encodeURIComponent('..') is '..', so the segment survived into the path and
  // the URL parser then dropped the segment above it.
  it.each(['.', '..', ' .. '])('rejects the dot segment %j', (name) => {
    expect(() => assertTagName(name, 'category')).toThrow(/not valid names/);
  });

  it('still accepts a name that merely contains dots', () => {
    expect(assertTagName('news.example.com', 'category')).toBe(
      'news.example.com'
    );
    expect(assertTagName('..dotted', 'category')).toBe('..dotted');
  });

  it('truncates an unexpected article id coming from the instance', () => {
    expect(() => itemIdToDecimal(`zz${'A'.repeat(400)}`)).toThrow(
      /unexpected article id/
    );
    try {
      itemIdToDecimal(`zz${'A'.repeat(400)}`);
    } catch (error) {
      expect((error as Error).message.length).toBeLessThan(200);
    }
  });
});

describe('result ceiling', () => {
  it('truncates when dropping article content is not enough', () => {
    // The bulk sits in a field the content replacer does not touch, which is what
    // an instance with tens of thousands of feeds produces.
    const feeds = Array.from({ length: 20_000 }, (_, i) => ({
      feedId: i,
      title: `Feed number ${i} with a fairly long title to add up`,
    }));
    // It used to answer with the JSON cut at the ceiling — unparseable, but
    // visible. That stopped being an option when every tool gained an output
    // schema: `structuredContent` has to parse, the two channels have to carry
    // the same value, and the SDK checks a result against the schema its tool
    // declares. There is no answer of this size.
    expect(() => jsonResult({ feeds })).toThrow(ResultTooLargeError);
  });

  it('keeps a small result untouched', () => {
    // The marker is part of the value now, in both channels: a client that
    // reads `structuredContent` can check a field where it would otherwise
    // have to notice a sentence in `notes`.
    expect(jsonResult({ a: 1 }).structuredContent).toEqual({
      untrusted: true,
      source: 'freshrss',
      a: 1,
    });
  });
});

describe('graceful degradation', () => {
  it('list_feeds still returns the feeds when unread-count fails', async () => {
    const result = await call(
      {
        '/subscription/list': JSON.stringify({
          subscriptions: [{ id: 'feed/7', title: 'Kept' }],
        }),
        '/unread-count': () => new Response('boom', { status: 500 }),
      },
      'list_feeds'
    );
    const data = dataOf(result);
    expect(result.isError).toBeFalsy();
    expect(data.feedCount).toBe(1);
    expect(JSON.stringify(data.notes)).toMatch(
      /unread counts could not be loaded/
    );
  });

  it('list_categories still returns the categories when unread-count fails', async () => {
    const result = await call(
      {
        '/tag/list': JSON.stringify({
          tags: [{ id: 'user/-/label/News', type: 'folder' }],
        }),
        '/unread-count': () => new Response('boom', { status: 500 }),
      },
      'list_categories'
    );
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(dataOf(result).categories)).toContain('News');
  });

  it('get_unread_counts still fails, because there the counts are the answer', async () => {
    const result = await call(
      {
        '/subscription/list': JSON.stringify({ subscriptions: [] }),
        '/unread-count': () => new Response('boom', { status: 500 }),
      },
      'get_unread_counts'
    );
    expect(result.isError).toBe(true);
  });
});

describe('OPML import', () => {
  it.each([
    '<!DOCTYPE opml [<!ENTITY a "b">]><opml/>',
    '<?xml version="1.0"?>\n<!doctype opml SYSTEM "http://evil.example/x.dtd">\n<opml/>',
  ])('refuses a document type declaration', async (opml) => {
    const result = await call({}, 'import_opml', { opml });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/document type or entity declaration/);
  });

  it('does not reach the API when a DOCTYPE is present', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    await client.callTool({
      name: 'import_opml',
      arguments: { opml: '<!DOCTYPE opml><opml/>' },
    });
    expect(stub.readerCalls).toHaveLength(0);
  });

  it('still accepts a plain OPML document', async () => {
    const result = await call({}, 'import_opml', {
      opml: '<opml><body><outline xmlUrl="https://news.example.com/rss"/></body></opml>',
    });
    // First step: a confirmation token. The prompt is an error result — the
    // import did not happen, and a tool that declares an `outputSchema` may
    // not answer without `structuredContent` unless the result is an error.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm_token/);
  });
});

describe('subscribe_feed SSRF guard', () => {
  // quickadd is a server-side fetch, so the URL is retrieved by the FreshRSS
  // host — and this tool is reachable from injected text inside an article.
  it.each([
    'http://127.0.0.1/feed',
    'http://localhost:8080/feed',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/feed',
    'http://0.0.0.0/feed',
    // GHSA-qqh2-7466-82f8: URL normalises an IPv4-mapped IPv6 literal into hex
    // before the guard sees it, so string comparison approved these while a
    // dual-stack client dials them as 127.0.0.1 and 169.254.169.254.
    'http://[::ffff:127.0.0.1]:8080/feed',
    'http://[::ffff:169.254.169.254]/latest/meta-data/iam/security-credentials/',
    'http://[::127.0.0.1]/feed',
    // The root label makes the same name look different to a string comparison.
    'http://localhost./feed',
    // Names for the metadata service: they resolve to 169.254.169.254 on the
    // FreshRSS host and to nothing here, so resolving cannot catch them.
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://instance-data/latest/meta-data/',
  ])('refuses %s', async (url) => {
    const result = await call({}, 'subscribe_feed', { url });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  it('does not reach the API for a refused URL', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    await client.callTool({
      name: 'subscribe_feed',
      arguments: { url: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(stub.readerCalls).toHaveLength(0);
  });

  it('still allows a private LAN feed, which self-hosted setups need', async () => {
    const result = await call(
      {
        '/subscription/quickadd': JSON.stringify({
          numResults: 1,
          streamId: 'feed/9',
        }),
      },
      'subscribe_feed',
      { url: 'http://192.168.1.50/rss.xml' }
    );

    expect(result.isError).toBeFalsy();
    expect(dataOf(result).feedId).toBe(9);
  });
});

describe('import_opml SSRF guard', () => {
  // GHSA-qqh2-7466-82f8, second finding: /subscription/import subscribes to
  // every xmlUrl and fetches it server-side — the capability subscribe_feed
  // guards, reached through a door that had no check on it at all.
  function opmlWith(url: string, attribute = 'xmlUrl'): string {
    return `<?xml version="1.0"?><opml version="2.0"><body><outline text="feed" ${attribute}="${url}"/></body></opml>`;
  }

  it.each([
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:8080/admin',
    'http://[::ffff:169.254.169.254]/latest/meta-data/',
    'http://localhost/feed',
  ])('refuses an OPML document pointing at %s', async (url) => {
    const result = await call({}, 'import_opml', { opml: opmlWith(url) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  it('refuses a loopback htmlUrl, which FreshRSS fetches for the favicon', async () => {
    const result = await call({}, 'import_opml', {
      opml: opmlWith('http://127.0.0.1:9000/', 'htmlUrl'),
    });
    expect(result.isError).toBe(true);
  });

  // The first fix read the attributes with a regular expression, which pairs
  // quotes by scanning raw text. A literal xmlUrl=" planted where the XML parser
  // does not see an attribute makes it pair the wrong quotes: it read a decoy
  // host while libxml read the real one next to it.
  it.each([
    [
      'a decoy inside a single-quoted attribute value',
      `<?xml version="1.0"?><opml version="2.0"><body><outline text='xmlUrl="http://news.example.com/rss' xmlUrl="http://169.254.169.254/latest/meta-data/iam/security-credentials/"/></body></opml>`,
    ],
    [
      'a decoy naming htmlUrl instead',
      `<?xml version="1.0"?><opml version="2.0"><body><outline text='htmlUrl="http://ok.example.com/' xmlUrl="http://127.0.0.1:8080/admin"/></body></opml>`,
    ],
    [
      'a decoy inside a comment, which libxml discards',
      `<?xml version="1.0"?><opml version="2.0"><body><!-- xmlUrl="http://ok.example.com/rss --><outline xmlUrl="http://169.254.169.254/latest/meta-data/"/></body></opml>`,
    ],
  ])('sees the real xmlUrl past %s', async (_name, opml) => {
    const result = await call({}, 'import_opml', { opml });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  it('does not reach the API for a document with a decoy attribute', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    await client.callTool({
      name: 'import_opml',
      arguments: {
        opml: `<opml><body><outline text='xmlUrl="http://ok.example.com/rss' xmlUrl="http://169.254.169.254/"/></body></opml>`,
      },
    });
    expect(stub.readerCalls).toHaveLength(0);
  });

  it('ignores a loopback URL that only appears in a comment', async () => {
    const result = await call({}, 'import_opml', {
      opml:
        '<opml><body><!-- example: xmlUrl="http://127.0.0.1/rss" -->' +
        '<outline xmlUrl="https://news.example.com/rss"/></body></opml>',
    });
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm_token/);
  });

  it.each([
    ['an unterminated attribute value', '<opml><outline xmlUrl="http://a/>'],
    ['an attribute with no value at all', '<opml><outline xmlUrl/></opml>'],
    ['an unquoted value', '<opml><outline xmlUrl=http://a/></opml>'],
    ['an unterminated comment', '<opml><!-- <outline xmlUrl="http://a/"/>'],
    ['an unterminated CDATA section', '<opml><![CDATA[ <outline'],
    ['an unterminated processing instruction', '<opml><?php echo 1'],
    ['an unterminated end tag', '<opml><body></body'],
    ['an unterminated start tag', '<opml><outline text="a"'],
    ['a "<" that starts no tag', '<opml>a < b</opml>'],
    ['a stray slash inside a tag', '<opml><outline / text="a"></opml>'],
    [
      'a declaration that is not a document type',
      '<opml><![IGNORE[x]]></opml>',
    ],
  ])('refuses a document with %s rather than guessing', async (_name, opml) => {
    const result = await call({}, 'import_opml', { opml });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not well-formed/);
  });

  it('reads past a CDATA section that contains markup', async () => {
    const result = await call({}, 'import_opml', {
      opml:
        '<opml><head><title><![CDATA[ <outline xmlUrl="http://127.0.0.1/"/> ]]></title>' +
        '</head><body><outline xmlUrl="https://news.example.com/rss"/></body></opml>',
    });
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('news.example.com');
  });

  it('reads past a processing instruction', async () => {
    const result = await call({}, 'import_opml', {
      opml:
        '<?xml version="1.0"?><?xml-stylesheet href="a.xsl"?>' +
        '<opml><body><outline xmlUrl="http://127.0.0.1/rss"/></body></opml>',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  it.each([
    ['a relative xmlUrl', 'rss.xml'],
    ['a protocol-relative xmlUrl on a routable host', '//news.example.com/rss'],
  ])('still imports %s', async (_name, url) => {
    const result = await call({}, 'import_opml', { opml: opmlWith(url) });
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm_token/);
  });

  it('refuses feed:// instead of downgrading it to plain http', async () => {
    // Reading it as the http URL it conventionally stands for would fetch over
    // plaintext a feed that is served over https, and subscribe_feed refuses the
    // scheme too — the two tools have to answer this the same way.
    const result = await call({}, 'import_opml', {
      opml: opmlWith('feed://news.example.com/rss'),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/only http:\/\/ and https:\/\//);
  });

  it.each([
    ['//169.254.169.254/rss'],
    ['http://metadata.google.internal/computeMetadata/v1/'],
    ['http://instance-data/latest/meta-data/'],
  ])('refuses %s, which still names the metadata service', async (url) => {
    const result = await call({}, 'import_opml', { opml: opmlWith(url) });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  // libxml believes the encoding declaration over the bytes, so a document that
  // declares UTF-7 is read as different characters on the FreshRSS side than
  // here: '+AHg-mlUrl' arrives there as 'xmlUrl', and '+ADw-' as '<'.
  it.each([
    [
      'an attribute name',
      `<?xml version="1.0" encoding="UTF-7"?><opml version="2.0"><body><outline text="a" +AHg-mlUrl="http://127.0.0.1/evil"/></body></opml>`,
    ],
    [
      'a whole element',
      `<?xml version="1.0" encoding="UTF-7"?><opml version="2.0"><body>+ADw-outline xmlUrl+AD0AIg-http://127.0.0.1/evil+ACIALwA+</body></opml>`,
    ],
    [
      'a document type declaration',
      `<?xml version="1.0" encoding="UTF-7"?>+ADw-!DOCTYPE opml [+ADw-!ENTITY e "http://169.254.169.254/latest/meta-data/">]><opml version="2.0"><body><outline text="a" xmlUrl="&e;"/></body></opml>`,
    ],
  ])('does not let a UTF-7 declaration smuggle %s', async (_name, opml) => {
    const stub = stubFreshRss({ '/subscription/import': 'OK' });
    const client = await connect();
    const first = (await client.callTool({
      name: 'import_opml',
      arguments: { opml },
    })) as CallToolResult;
    const token = /confirm_token="([^"]+)"/.exec(textOf(first))?.[1];
    if (token !== undefined) {
      await client.callTool({
        name: 'import_opml',
        arguments: { opml, confirm_token: token },
      });
    }
    // Whatever reaches FreshRSS must no longer claim an encoding that makes it
    // read characters this check never saw.
    for (const call of stub.readerCalls) {
      expect(call.body.toLowerCase()).not.toContain('utf-7');
    }
  });

  it('sends the URL it checked, not one a fetcher would read differently', async () => {
    // WHATWG URL reads the host of this as ok.example.com; curl splits at the @
    // and connects to 127.0.0.1. Forwarding the document verbatim would mean
    // checking one host and fetching another.
    const opml = opmlWith('http://ok.example.com\\@127.0.0.1/feed');
    const stub = stubFreshRss({ '/subscription/import': 'OK' });
    const client = await connect();
    const first = (await client.callTool({
      name: 'import_opml',
      arguments: { opml },
    })) as CallToolResult;
    const token = /confirm_token="([^"]+)"/.exec(textOf(first))?.[1] as string;
    await client.callTool({
      name: 'import_opml',
      arguments: { opml, confirm_token: token },
    });
    const sent = stub.readerCalls.at(-1)?.body ?? '';
    expect(sent).toContain('http://ok.example.com/@127.0.0.1/feed');
    expect(sent).not.toContain('ok.example.com\\@');
  });

  it('sees an xmlUrl behind a namespace prefix', async () => {
    const result = await call({}, 'import_opml', {
      opml: '<opml version="2.0" xmlns:o="urn:x"><body><outline o:xmlUrl="http://127.0.0.1/evil"/></body></opml>',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  it('refuses a file:// xmlUrl, which would read the FreshRSS host disk', async () => {
    const result = await call({}, 'import_opml', {
      opml: opmlWith('file:///etc/passwd'),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/only http:\/\/ and https:\/\//);
  });

  it('decodes entities before checking, as libxml does', async () => {
    // Read raw this is host '169&' — the '#' would start a fragment. FreshRSS
    // sees http://169.254.169.254/ because libxml resolves the reference first.
    const result = await call({}, 'import_opml', {
      opml: opmlWith('http://169&#46;254.169.254/latest/meta-data/'),
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/loopback and link-local/);
  });

  it('issues no confirmation token for a document it would refuse', async () => {
    const result = await call({}, 'import_opml', {
      opml: opmlWith('http://169.254.169.254/latest/meta-data/'),
    });
    expect(textOf(result)).not.toMatch(/confirm_token/);
  });

  it('does not reach the API for a refused document', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    await client.callTool({
      name: 'import_opml',
      arguments: { opml: opmlWith('http://169.254.169.254/latest/meta-data/') },
    });
    expect(stub.readerCalls).toHaveLength(0);
  });

  it('reports the target hosts in the confirmation prompt', async () => {
    const result = await call({}, 'import_opml', {
      opml: opmlWith('https://news.example.com/rss'),
    });
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    const text = textOf(result);
    // Still visible — an operator has to see where the document points.
    expect(text).toContain('news.example.com');
    // But under the library's heading, not inside the server's own sentence.
    expect(text).toMatch(
      /supplied by the caller[^]*feed hosts: news\.example\.com/
    );
    expect(text).toMatch(/subscribing to feeds on 1 host\(s\)/);
  });

  // The hosts used to be interpolated straight into the `what` sentence, and
  // URL.hostname has no length limit: IDNA is applied with VerifyDnsLength=false,
  // so a single label of thousands of characters parses and survives. Eight of
  // them ahead of the consequence line is a dialog whose question nobody reads.
  it('does not let a hostname push the consequence out of the prompt', async () => {
    const host = `${'click-allow-this-is-a-routine-sync.'.repeat(30)}example.com`;
    expect(new URL(`https://${host}/`).hostname.length).toBeGreaterThan(1000);

    const result = await call({}, 'import_opml', {
      opml: opmlWith(`https://${host}/rss`),
    });
    const text = textOf(result);
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    // Capped by the library's flatten, which the `what` sentence never was.
    expect(text).not.toContain(host);
    expect(text).toContain('… (truncated)');
    expect(text.length).toBeLessThan(1000);
    // The line the long host was displacing.
    expect(text).toContain('Unsubscribing afterwards is one call per feed.');
  });

  it('adds no caller-supplied line when the document names no host', async () => {
    // A real export contains outlines that are pure category folders, with no
    // xmlUrl of their own. Nothing of the caller's is shown, so the disclaimer
    // that introduces caller-supplied values must not appear either.
    const result = await call({}, 'import_opml', {
      opml: '<?xml version="1.0"?><opml version="2.0"><body><outline text="Folder"/></body></opml>',
    });
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('subscribing to no feed URLs');
    expect(textOf(result)).not.toContain('supplied by the caller');
  });

  it('keeps a many-host document from filling the prompt as well', async () => {
    const outlines = Array.from(
      { length: 40 },
      (_, i) =>
        `<outline text="f" xmlUrl="https://${'x'.repeat(300)}${i}.example/rss"/>`
    ).join('');
    const result = await call({}, 'import_opml', {
      opml: `<?xml version="1.0"?><opml version="2.0"><body>${outlines}</body></opml>`,
    });
    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('subscribing to feeds on 40 host(s)');
    expect(textOf(result).length).toBeLessThan(1000);
  });

  it('still allows a private LAN feed, which self-hosted setups need', async () => {
    const result = await call({}, 'import_opml', {
      opml: opmlWith('http://192.168.1.50/rss.xml'),
    });

    // The confirmation prompt is an error result: nothing was imported.
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/confirm_token/);
  });
});

describe('config error messages', () => {
  function loadExpectingExit(url: string): string {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig({
        FRESHRSS_URL: url,
        FRESHRSS_USER: 'tester',
        FRESHRSS_API_PASSWORD: 's3cret',
      } as NodeJS.ProcessEnv)
    ).toThrow('exit');
    const logged = spy.mock.calls.flat().join(' ');
    exit.mockRestore();
    spy.mockRestore();
    return logged;
  }

  // The userinfo check only runs once the URL parses, so a value that carries
  // credentials AND fails to parse is the one that could reach stderr verbatim.
  // An out-of-range port is the reachable case: `new URL` throws on it.
  it('does not print the password when the URL does not parse', () => {
    const logged = loadExpectingExit(
      'https://admin:s3cret@rss.example.com:99999'
    );
    expect(logged).toMatch(/not a valid URL/);
    expect(logged).not.toContain('s3cret');
    expect(logged).toContain('***@');
  });

  // A typo'd scheme parses fine and is rejected further down, where only the
  // protocol is quoted — no credentials in that message either.
  it('does not print the password for an unsupported scheme', () => {
    const logged = loadExpectingExit('htp://admin:s3cret@rss.example.com');
    expect(logged).toMatch(/must use http/);
    expect(logged).not.toContain('s3cret');
  });
});

describe('get_articles error handling', () => {
  it('reports a non-JSON body with the base-URL hint instead of a SyntaxError', async () => {
    const result = await call(
      {
        '/stream/items/contents': () =>
          new Response('<html><body>Gateway</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
      },
      'get_articles',
      { article_ids: ['123'] }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not JSON/);
    expect(textOf(result)).toMatch(/root of the FreshRSS instance/);
    expect(textOf(result)).not.toMatch(/Unexpected token/);
  });
});

describe('article text sanitising', () => {
  it('strips raw control characters, including ANSI escapes', () => {
    const { text } = htmlToText(
      '<p>before\u001b[31mred\u001b[0m\u0007after</p>',
      500
    );
    // eslint-disable-next-line no-control-regex -- asserting their absence is the point
    expect(text).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  it('keeps newlines and tabs, which are real formatting', () => {
    const { text } = htmlToText('<p>a</p><p>b</p>', 500);
    expect(text).toBe('a\nb');
  });

  it('debits excerpts against the total budget', () => {
    const notes = new Notes();
    const budget = { left: 50 };
    const options = {
      includeContent: false,
      maxContentChars: 2000,
      totalContentBudget: 50,
    };
    const long = { summary: { content: `<p>${'x'.repeat(400)}</p>` } };
    const first = shapeEntry(
      rawEntry(long),
      (id) => id,
      options,
      budget,
      notes
    );
    expect(first.excerpt).toBeDefined();
    expect(budget.left).toBeLessThanOrEqual(0);
    // Second article: the budget is gone, so no excerpt rides along unbounded.
    const second = shapeEntry(
      rawEntry(long),
      (id) => id,
      options,
      budget,
      notes
    );
    expect(second.excerpt).toBeUndefined();
    expect(second.contentOmitted).toBe('budget');
  });

  // stripMarkup removed tags with /<[^>]+>/g inside a fixpoint loop. Every `<`
  // with no `>` behind it made `[^>]+` run to the end of the input and then
  // backtrack a character at a time, so a feed could buy quadratic work with
  // linear bytes. The measurements that opened the finding, on this machine:
  // 8821 ms for the raw payload and 1434 ms for the escaped one, per article.
  // Both are milliseconds now. The bound below is deliberately far above the
  // repaired figure and far below the broken one, so a slow CI runner does not
  // make it flap while a reintroduced regex still trips it.
  const LINEAR_TIME_MS = 1000;

  function millisecondsFor(html: string, limit: number): number {
    const started = performance.now();
    htmlToText(html, limit);
    return performance.now() - started;
  }

  it('converts a body of unterminated tag starts in linear time', () => {
    // Strips to nothing, so it is invisible in the result — which is what made
    // it worth sending: the cost was all in the conversion.
    expect(millisecondsFor('<a'.repeat(122_048), 20_000)).toBeLessThan(
      LINEAR_TIME_MS
    );
  });

  it('converts escaped tag starts in linear time as well', () => {
    // The reachable half of the finding. `&lt;a` is escaped *text*, not markup,
    // so no sanitiser on the FreshRSS or SimplePie path has reason to touch it —
    // and htmlToText decodes entities between its two strip passes, which hands
    // the second pass the pathological string.
    const escaped = `<p>${'&lt;a'.repeat(122_048)}</p>`;
    expect(millisecondsFor(escaped, 20_000)).toBeLessThan(LINEAR_TIME_MS);
  });

  it.each([
    ['a bare < that closes nothing', '<'.repeat(244_096)],
    ['tag starts that never close', '< a'.repeat(81_365)],
    [
      'closing tags for an element that never opened',
      '</script '.repeat(24_409),
    ],
    [
      'a script body full of near-misses',
      `<script>${'</script'.repeat(15_000)}${' '.repeat(120_000)}`,
    ],
  ])('stays linear on %s', (_name, html) => {
    expect(millisecondsFor(html, 20_000)).toBeLessThan(LINEAR_TIME_MS);
  });

  it('charges the response budget for markup that strips to nothing', () => {
    // The amplifier. The budget was debited by the *output* length, so a payload
    // stripping to '' cost nothing, the budget stayed whole, and every further
    // article of the same list_articles response was handed a full slice again —
    // up to a hundred of them.
    const notes = new Notes();
    const budget = { left: 60_000 };
    const options = {
      includeContent: true,
      maxContentChars: 20_000,
      totalContentBudget: 60_000,
    };
    const payload = { summary: { content: '<a'.repeat(122_048) } };
    const shapes = Array.from({ length: 4 }, () =>
      shapeEntry(rawEntry(payload), (id) => id, options, budget, notes)
    );

    expect(shapes[0]?.content).toBe('');
    expect(budget.left).toBeLessThan(60_000);
    // Three slices is what the budget pays for, so the fourth article is not
    // converted at all rather than being free because it produces nothing.
    expect(shapes[3]?.contentOmitted).toBe('budget');
  });

  it('still charges ordinary articles by the text they return', () => {
    // The counterpart: the change must not make normal content expensive. An
    // article whose markup is mostly text costs its text, as it always did.
    const budget = { left: 60_000 };
    shapeEntry(
      rawEntry({ summary: { content: `<p>${'word '.repeat(400)}</p>` } }),
      (id) => id,
      {
        includeContent: true,
        maxContentChars: 2000,
        totalContentBudget: 60_000,
      },
      budget,
      new Notes()
    );
    expect(60_000 - budget.left).toBe(1999);
  });
});

describe('zod strip invariant', () => {
  // The schemas must not let a caller-injected field through to the API. `T` is
  // the write token and `s`/`ac` steer subscription/edit, so a passthrough
  // schema would hand the model control over the request itself.
  it('drops unknown fields instead of forwarding them', async () => {
    const stub = stubFreshRss({ '/edit-tag': 'OK' });
    const client = await connect({}, 'accept');
    const result = (await client.callTool({
      name: 'mark_articles',
      arguments: {
        article_ids: ['123'],
        read: true,
        T: 'attacker-token',
        ac: 'unsubscribe',
        s: 'feed/1',
        __proto__: { polluted: true },
      },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();

    const editTag = stub.readerCalls.find((c) => c.url.includes('/edit-tag'));
    expect(editTag).toBeDefined();
    expect(editTag?.form.get('ac')).toBeNull();
    expect(editTag?.form.getAll('s')).toEqual([]);
    // T is set by the client from /token, never from the caller.
    expect(editTag?.form.get('T')).not.toBe('attacker-token');
    expect(
      (Object.prototype as unknown as { polluted?: unknown }).polluted
    ).toBeUndefined();
  });
});

describe('empty-result hint', () => {
  // Verified live against FreshRSS 1.29.1: an unknown category, label or feed id
  // returns HTTP 200 with an empty items array, not an error. Only a malformed
  // built-in stream id produces 400. A mistyped name is therefore
  // indistinguishable from "nothing unread" unless it is said out loud.
  it('explains an empty listing for a category or label selector', () => {
    expect(emptyResultHint(0, { category: 'Nope' })).toMatch(/list_categories/);
    expect(emptyResultHint(0, { label: 'Nope' })).toMatch(
      /rather than an error/
    );
  });

  it('explains an empty listing for a feed id selector', () => {
    expect(emptyResultHint(0, { feed_id: 999 })).toMatch(/list_feeds/);
  });

  it('stays quiet when articles were returned', () => {
    expect(emptyResultHint(3, { category: 'News' })).toBeUndefined();
  });

  it('stays quiet for a built-in stream, which does error on a bad name', () => {
    expect(emptyResultHint(0, { stream: 'starred' })).toBeUndefined();
    expect(emptyResultHint(0, {})).toBeUndefined();
  });

  it('reaches the tool result', async () => {
    const result = await call(
      {
        '/stream/contents/user/-/label/DoesNotExist': JSON.stringify({
          items: [],
        }),
      },
      'list_articles',
      { category: 'DoesNotExist' }
    );
    expect(String(dataOf(result).hint)).toMatch(/list_categories/);
  });
});
