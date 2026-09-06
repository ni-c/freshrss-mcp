import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FreshRssApi,
  HttpClient,
  MAX_RESPONSE_BYTES,
  upstreamText,
} from '../src/api.js';
import { AuthSession } from '../src/auth.js';
import { loadConfig, parseElicitation } from '../src/config.js';
import { run } from '../src/result.js';
import { cleanText, Notes, shapeEntry } from '../src/shape.js';
import { assertArticleId, itemIdToDecimal } from '../src/streams.js';
import {
  connect,
  dataOf,
  rawEntry,
  stubFreshRss,
  testConfig,
  textOf,
  type Routes,
} from './harness.js';

/**
 * The findings of the internal review of 2026-09-06, each pinned by the
 * behaviour it changed rather than by the code that changed. Where a finding
 * has a request body or a thrown error to assert on, that is what is asserted.
 */

const ESC = '\u001b';

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

describe('the write token after a password change', () => {
  it('is fetched afresh for the retry, not resent from the first attempt', async () => {
    // Both tokens derive from the API password hash, so after a change both
    // are stale. `authed` retries once after a 401 — and used to resend the
    // form it was first handed, old `T` included, under a fresh login.
    let logins = 0;
    let tokens = 0;
    const posts: URLSearchParams[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/ClientLogin')) {
          logins++;
          return new Response(`Auth=tester/login${logins}\n`);
        }
        if (path.endsWith('/token')) {
          tokens++;
          return new Response(`token${tokens}`);
        }
        const form = new URLSearchParams(String(init?.body));
        posts.push(form);
        return form.get('T') === 'token2'
          ? new Response('OK')
          : new Response('', { status: 401 });
      }
    );

    const api = new FreshRssApi(testConfig());
    const body = await api.postForm(
      '/edit-tag',
      new URLSearchParams({ i: '1' })
    );
    expect(body).toBe('OK');
    expect(posts.map((form) => form.get('T'))).toEqual(['token1', 'token2']);
    expect(logins).toBe(2);
  });
});

describe('the response ceiling', () => {
  it('refuses a declared length above the ceiling before reading', async () => {
    // The stream primes itself with one pull on construction; what must not
    // happen is a second one, and the body must be cancelled rather than left.
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, {
        headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
      })
    );
    const http = new HttpClient(testConfig());
    await expect(http.send('GET', '/x')).rejects.toThrow(/more than/);
    expect(pulls).toBeLessThanOrEqual(1);
    expect(cancelled).toBe(true);
  });

  it('stops reading an undeclared body once it passes the ceiling', async () => {
    const chunk = 1024 * 1024;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const http = new HttpClient(testConfig());
    await expect(http.send('GET', '/x')).rejects.toThrow(/refuses to buffer/);
    // The ceiling plus at most a chunk or two of read-ahead, never the body.
    expect(sent).toBeLessThanOrEqual(MAX_RESPONSE_BYTES + 2 * chunk);
  });

  it('joins a body that arrives in several chunks', async () => {
    const parts = ['{"a":', '1}'].map((part) => new TextEncoder().encode(part));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const http = new HttpClient(testConfig());
    expect((await http.send('GET', '/x')).text).toBe('{"a":1}');
  });

  it('reads an empty body as empty text', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const http = new HttpClient(testConfig());
    expect((await http.send('GET', '/x')).text).toBe('');
  });

  it('reaches the model as an error result, not a crash', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/ClientLogin')) return new Response('Auth=t/a\n');
        return new Response('{}', {
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        });
      }
    );
    const client = await connect();
    const result = (await client.callTool({
      name: 'list_feeds',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Narrow the request/);
  });
});

describe('article id length', () => {
  it('caps a caller-supplied decimal id at 20 digits', () => {
    expect(assertArticleId('9'.repeat(20))).toBe('9'.repeat(20));
    expect(() => assertArticleId('9'.repeat(21))).toThrow(/invalid article id/);
  });

  it('caps the hexadecimal form at 16 digits, from the caller and the instance', () => {
    const prefix = 'tag:google.com,2005:reader/item/';
    expect(assertArticleId(`${prefix}${'f'.repeat(16)}`)).toBe(
      BigInt(`0x${'f'.repeat(16)}`).toString(10)
    );
    expect(() => assertArticleId(`${prefix}${'f'.repeat(17)}`)).toThrow(
      /unexpected article id/
    );
    expect(() => itemIdToDecimal('f'.repeat(5000))).toThrow(
      /unexpected article id/
    );
    expect(() => itemIdToDecimal('1'.repeat(21))).toThrow(
      /unexpected article id/
    );
  });

  it('shortens an overlong id in the error message', () => {
    let message = '';
    try {
      assertArticleId(`x${'y'.repeat(500)}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/invalid article id/);
    expect(message.length).toBeLessThan(300);
  });
});

describe('label lists', () => {
  it('refuses more than 50 labels in one mark_articles call', async () => {
    const result = await call({}, 'mark_articles', {
      article_ids: ['1'],
      add_labels: Array.from({ length: 51 }, (_, i) => `l${i}`),
    });
    expect(result.isError).toBe(true);
  });
});

describe('text the instance wrote', () => {
  it('is bounded, marked and stripped of control characters', () => {
    const text = upstreamText(`${ESC}[31m${'x'.repeat(300)}`);
    expect(text).toMatch(/^\(untrusted text from the instance\): \[31mx+…$/);
    expect(text).not.toContain(ESC);
    expect(text.length).toBeLessThan(260);
  });

  it('marks and bounds the quickadd error of subscribe_feed', async () => {
    const result = await call(
      {
        '/subscription/quickadd': JSON.stringify({
          numResults: 0,
          error: `${ESC}[2J${'a'.repeat(1000)}`,
        }),
      },
      'subscribe_feed',
      { url: 'https://feeds.example.com/x' }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('untrusted text from the instance');
    expect(textOf(result)).not.toContain(ESC);
    expect(textOf(result).length).toBeLessThan(400);
  });

  it('bounds an unexpected stream id of subscribe_feed', async () => {
    const result = await call(
      {
        '/subscription/quickadd': JSON.stringify({
          numResults: 1,
          streamId: `nonsense/${'z'.repeat(1000)}`,
        }),
      },
      'subscribe_feed',
      { url: 'https://feeds.example.com/x' }
    );
    expect(result.isError).toBe(true);
    expect(textOf(result).length).toBeLessThan(300);
  });

  it('marks a non-HTML upstream error body', async () => {
    const result = await call(
      {
        '/subscription/list': () =>
          new Response(`Service ${ESC}[1mdown`, { status: 502 }),
      },
      'list_feeds'
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(
      '(untrusted text from the instance): Service [1mdown'
    );
    expect(textOf(result)).not.toContain(ESC);
  });
});

describe('publisher-written fields', () => {
  it('redacts credentials in article and enclosure URLs', () => {
    const shaped = shapeEntry(
      rawEntry({
        canonical: [{ href: 'https://alice:secret@news.example.com/a' }],
        alternate: [],
        enclosure: [
          {
            href: 'https://bob:hunter2@cdn.example.com/a.mp3',
            type: 'audio/mpeg',
          },
        ],
      }),
      itemIdToDecimal,
      { includeContent: false, maxContentChars: 100, totalContentBudget: 1000 },
      { left: 1000 },
      new Notes()
    );
    expect(shaped.url).toBe('https://***@news.example.com/a');
    expect(shaped.enclosures).toEqual([
      { url: 'https://***@cdn.example.com/a.mp3', type: 'audio/mpeg' },
    ]);
    expect(JSON.stringify(shaped)).not.toMatch(/secret|hunter2/);
  });

  it('strips control characters from title, author and feed title', () => {
    const shaped = shapeEntry(
      rawEntry({
        title: `Head${ESC}[31mline`,
        author: 'Jane \u0007Doe',
        origin: { streamId: 'feed/12', title: 'Example\u007f' },
      }),
      itemIdToDecimal,
      { includeContent: false, maxContentChars: 100, totalContentBudget: 1000 },
      { left: 1000 },
      new Notes()
    );
    expect(shaped.title).toBe('Head[31mline');
    expect(shaped.author).toBe('Jane Doe');
    expect(shaped.feed).toEqual({ id: 12, title: 'Example' });
    expect(cleanText(undefined)).toBeUndefined();
    expect(cleanText('a\tb\nc')).toBe('a\tb\nc');
  });
});

describe('ELICITATION diagnostics', () => {
  it('echoes a shortened, printable version of a bad value', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    parseElicitation(`${ESC}[2J${'p'.repeat(100)}`);
    expect(exit).toHaveBeenCalledWith(1);
    const line = String(error.mock.calls[0]?.[0]);
    expect(line).not.toContain(ESC);
    expect(line).toContain(`got "[2J${'p'.repeat(37)}"`);
  });
});

describe('FRESHRSS_URL normalisation', () => {
  it('keeps origin and path and drops what is not a base URL', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = loadConfig({
      FRESHRSS_URL: ' https://rss.example.com/reader/?x=1#top ',
      FRESHRSS_USER: 'u',
      FRESHRSS_API_PASSWORD: 'p',
    });
    expect(config.url).toBe('https://rss.example.com/reader');
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('query or fragment')
    );
  });
});

describe('import_opml and a URL that will not parse', () => {
  it('refuses an absolute URL it cannot read instead of passing it on', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    const result = (await client.callTool({
      name: 'import_opml',
      arguments: {
        opml: '<opml><body><outline xmlUrl="http://127.0.0.1 :80/feed"/></body></opml>',
      },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a valid URL/);
    expect(stub.readerCalls).toHaveLength(0);
  });

  it('still leaves a relative value alone', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    const result = (await client.callTool({
      name: 'import_opml',
      arguments: {
        opml: '<opml><body><outline xmlUrl="feeds/local.xml"/></body></opml>',
      },
    })) as CallToolResult;
    // Not refused: the first call answers with the confirmation token.
    expect(textOf(result)).toMatch(/confirm_token/);
    expect(stub.readerCalls).toHaveLength(0);
  });
});

describe('own-words results', () => {
  /**
   * A client that has loaded `tools/list` validates every `structuredContent`
   * against the tool's output schema, and both schemas here are closed. The
   * marker `jsonResult` adds — two fields neither schema names — made a
   * validating client throw a ProtocolError on the success path of both
   * tools, while a client that skipped `tools/list` saw nothing wrong.
   */
  it('survive a client that validates against the listed schema', async () => {
    stubFreshRss({
      '/user-info': JSON.stringify({ userId: '1', userName: 'tester' }),
      '/subscription/quickadd': JSON.stringify({
        numResults: 1,
        streamId: 'feed/7',
      }),
    });
    const client = await connect();
    await client.listTools();
    const user = (await client.callTool({
      name: 'get_user_info',
      arguments: {},
    })) as CallToolResult;
    expect(user.isError).toBeFalsy();
    expect(dataOf(user)).toEqual({ userId: '1', userName: 'tester' });
    const subscribed = (await client.callTool({
      name: 'subscribe_feed',
      arguments: { url: 'https://feeds.example.com/x' },
    })) as CallToolResult;
    expect(subscribed.isError).toBeFalsy();
    expect(dataOf(subscribed)).toMatchObject({ feedId: 7 });
  });

  it('get_user_info says the same thing in both channels', async () => {
    const result = await call(
      { '/user-info': JSON.stringify({ userId: '1', userName: 'tester' }) },
      'get_user_info'
    );
    expect(result.structuredContent).toEqual({
      userId: '1',
      userName: 'tester',
    });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
  });

  it('subscribe_feed says the same thing in both channels', async () => {
    const result = await call(
      {
        '/subscription/quickadd': JSON.stringify({
          numResults: 1,
          streamId: 'feed/7',
        }),
      },
      'subscribe_feed',
      { url: 'https://feeds.example.com/x' }
    );
    expect(dataOf(result)).toMatchObject({ feedId: 7, subscribed: true });
    expect(JSON.parse(textOf(result))).toEqual(result.structuredContent);
    expect(result.structuredContent).not.toHaveProperty('untrusted');
  });
});

describe('branches the suite had not reached', () => {
  it('reports a refused or empty write token', async () => {
    const answers = ['', 'refuse'];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith('/ClientLogin')) return new Response('Auth=t/a\n');
        const answer = answers.shift();
        return answer === 'refuse'
          ? new Response('', { status: 403 })
          : new Response(answer ?? '');
      }
    );
    const http = new HttpClient(testConfig());
    await expect(
      new AuthSession(testConfig(), http).writeToken()
    ).rejects.toThrow(/empty write token/);
    await expect(
      new AuthSession(testConfig(), http).writeToken()
    ).rejects.toThrow(/refused to issue a write token \(HTTP 403\)/);
  });

  it.each([
    [404, /root of the FreshRSS instance/],
    [501, /does not implement/],
    [503, /Allow API access/],
  ])('hints at the cause of HTTP %i', async (status, hint) => {
    const result = await call(
      { '/user-info': () => new Response('nope', { status }) },
      'get_user_info'
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(hint);
  });

  it('shapes an entry with the optional fields missing', () => {
    const shaped = shapeEntry(
      rawEntry({
        id: undefined,
        published: 'yesterday',
        canonical: undefined,
        alternate: [{ href: 'https://alt.example.com/a' }],
        summary: undefined,
        content: undefined,
      }),
      itemIdToDecimal,
      { includeContent: true, maxContentChars: 100, totalContentBudget: 1000 },
      { left: 1000 },
      new Notes()
    );
    expect(shaped.id).toBe('');
    expect(shaped.published).toBeUndefined();
    expect(shaped.url).toBe('https://alt.example.com/a');
    expect(shaped.content).toBeUndefined();
  });

  it('maps filter=read and remove_labels onto the request', async () => {
    const stub = stubFreshRss({
      '/stream/contents/user/-/state/com.google/reading-list': JSON.stringify({
        items: [],
      }),
      '/edit-tag': 'OK',
    });
    const client = await connect();
    await client.callTool({
      name: 'list_articles',
      arguments: { filter: 'read' },
    });
    expect(stub.readerCalls[0]?.url).toContain(
      encodeURIComponent('user/-/state/com.google/read')
    );
    const marked = (await client.callTool({
      name: 'mark_articles',
      arguments: { article_ids: ['5'], remove_labels: ['Old'] },
    })) as CallToolResult;
    expect(stub.readerCalls[1]?.form.getAll('r')).toEqual(['user/-/label/Old']);
    expect(dataOf(marked).changes).toBe('removed 1 label(s)');
  });

  it('lists feeds and counts when the instance leaves fields out', async () => {
    const feeds = await call(
      { '/subscription/list': '{}', '/unread-count': '{}' },
      'list_feeds'
    );
    expect(dataOf(feeds).feedCount).toBe(0);

    const counts = await call(
      {
        '/subscription/list': JSON.stringify({
          subscriptions: [{ id: 'feed/3' }, { id: 'bogus', title: 'x' }],
        }),
        '/unread-count': JSON.stringify({
          unreadcounts: [
            { id: 'feed/3', count: 2 },
            { id: 'user/-/label/News', count: 1 },
            { id: 'user/-/state/com.google/reading-list', count: 3 },
            { id: 'feed/4', count: 0 },
          ],
        }),
      },
      'get_unread_counts'
    );
    expect(dataOf(counts).feeds).toEqual([
      { feedId: 3, title: undefined, unread: 2 },
    ]);
    expect(dataOf(counts).categoriesAndLabels).toEqual([
      { name: 'News', unread: 1 },
    ]);
  });

  it('lists categories when the instance leaves fields out', async () => {
    const result = await call(
      {
        '/tag/list': JSON.stringify({
          tags: [{ id: 'user/-/label/News' }, { id: 'user/-/state/x' }],
        }),
        '/unread-count': JSON.stringify({
          unreadcounts: [{ id: 'user/-/label/News', count: 4 }],
        }),
      },
      'list_categories'
    );
    expect(dataOf(result).categories).toEqual([
      { name: 'News', unreadCount: 4 },
    ]);
    const empty = await call(
      { '/tag/list': '{}', '/unread-count': '{}' },
      'list_categories'
    );
    expect(dataOf(empty).categories).toEqual([]);
  });

  it('updates only the category of a feed', async () => {
    const stub = stubFreshRss({ '/subscription/edit': 'OK' });
    const client = await connect();
    await client.callTool({
      name: 'update_feed',
      arguments: { feed_id: 3, category: 'Tech' },
    });
    const form = stub.readerCalls[0]?.form;
    expect(form?.get('a')).toBe('user/-/label/Tech');
    expect(form?.has('t')).toBe(false);
  });

  it('reads OPML documents with a BOM, an empty URL and odd entities', async () => {
    const stub = stubFreshRss({});
    const client = await connect();
    const accepted = (await client.callTool({
      name: 'import_opml',
      arguments: {
        opml:
          '\ufeff<?xml version="1.0"?><opml><body>' +
          '<outline xmlUrl="" htmlUrl="https://a.example.com/&#x2e;&#1114112;&#0;"/>' +
          '</body></opml>',
      },
    })) as CallToolResult;
    expect(textOf(accepted)).toMatch(/confirm_token/);
    expect(stub.readerCalls).toHaveLength(0);

    for (const [opml, reason] of [
      ['<?xml version="1.0"', /unterminated XML declaration/],
      ['<opml><outline =x></opml>', /unreadable attribute name/],
      ['<opml>text</opml> trailing', /confirm_token/],
    ] as const) {
      const result = (await client.callTool({
        name: 'import_opml',
        arguments: { opml },
      })) as CallToolResult;
      expect(textOf(result)).toMatch(reason);
    }
  });

  it('turns an unknown error into an error result', async () => {
    const result = await run(async () => {
      throw 'a string, not an Error';
    });
    expect(textOf(result as CallToolResult)).toBe(
      'freshrss-mcp: a string, not an Error'
    );
  });
});
