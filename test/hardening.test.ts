/**
 * Regression tests for the findings of the pre-release security audit.
 *
 * Every `it` here corresponds to a defect that was actually present, so a
 * failure means a specific hardening measure was removed rather than a style
 * preference being violated. The audit note is quoted in each case.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from '../src/config.js';
import { ConfirmationStore } from '../src/confirm.js';
import { redactOpmlCredentials, redactUrlCredentials } from '../src/redact.js';
import { jsonResult } from '../src/result.js';
import {
  htmlToText,
  Notes,
  shapeEntry,
  shapeSubscription,
  UNTRUSTED_CONTENT_NOTE,
} from '../src/shape.js';
import { createServer } from '../src/server.js';
import { assertTagName, itemIdToDecimal } from '../src/streams.js';
import { emptyResultHint } from '../src/tools/articles.js';
import { rawEntry, stubFreshRss, testConfig, type Routes } from './helpers.js';

async function connect(): Promise<Client> {
  const server = createServer(testConfig);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('no text content');
  return first.text;
}

function dataOf(result: CallToolResult): Record<string, unknown> {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

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
    const text = textOf(jsonResult({ feeds }));
    expect(text.length).toBeLessThan(420_000);
    expect(text).toMatch(/truncated/);
  });

  it('keeps a small result untouched', () => {
    expect(textOf(jsonResult({ a: 1 }))).toBe('{\n  "a": 1\n}');
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
    // First step: a confirmation token, not an error.
    expect(result.isError).toBeFalsy();
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
});

describe('confirmation tokens', () => {
  it('purges an expired token instead of leaving it in the map', () => {
    const store = new ConfirmationStore(1);
    const token = store.issue('op:x');
    vi.useFakeTimers();
    vi.advanceTimersByTime(10);
    expect(store.consume('op:x', token)).toBe(false);
    // Purged, so even a clock that moves back cannot revive it.
    vi.useRealTimers();
    expect(store.consume('op:x', token)).toBe(false);
  });

  it('rejects a token of a different length without throwing', () => {
    const store = new ConfirmationStore();
    store.issue('op:x');
    expect(store.consume('op:x', 'short')).toBe(false);
    expect(store.consume('op:x', 'f'.repeat(200))).toBe(false);
  });
});

describe('zod strip invariant', () => {
  // The schemas must not let a caller-injected field through to the API. `T` is
  // the write token and `s`/`ac` steer subscription/edit, so a passthrough
  // schema would hand the model control over the request itself.
  it('drops unknown fields instead of forwarding them', async () => {
    const stub = stubFreshRss({ '/edit-tag': 'OK' });
    const client = await connect();
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
