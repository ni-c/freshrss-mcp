/**
 * The findings of the second internal security review (2026-09-07), one test
 * each. Every test asserts on a request count, a result or a thrown error —
 * never on "the guard was called".
 */
import { readFileSync } from 'node:fs';
import type { CallToolResult } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_RESPONSE_BYTES, upstreamText } from '../src/api.js';
import { LOGIN_COOLDOWN_MS, parseClientLogin } from '../src/auth.js';
import { describeUrlValue, loadConfig } from '../src/config.js';
import { cleanText, feedIdFromStreamId, htmlToText } from '../src/shape.js';
import {
  confirmed,
  connect,
  dataOf,
  rawEntry,
  stubFreshRss,
  textOf,
  tokenOf,
} from './harness.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);
const LONE_SURROGATE = String.fromCharCode(0xd800);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  lookup.mockReset();
});

/** A fetch that answers the login itself, so a refusal can be scripted. */
function stubLogin(
  answer: () => Response,
  reader: () => Response = () => new Response('{}')
): { logins: () => number } {
  let logins = 0;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/accounts/ClientLogin')) {
      logins++;
      return answer();
    }
    if (path.endsWith('/reader/api/0/token'))
      return new Response('w'.repeat(57));
    return reader();
  });
  return { logins: () => logins };
}

async function userInfo(
  client: Awaited<ReturnType<typeof connect>>
): Promise<CallToolResult> {
  return (await client.callTool({
    name: 'get_user_info',
    arguments: {},
  })) as CallToolResult;
}

describe('M-1: a refused login is not retried for ten seconds', () => {
  it('answers the second call from memory and logs in again after the cooldown', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const stub = stubLogin(() => new Response('Unauthorized', { status: 401 }));
    const client = await connect();

    const first = await userInfo(client);
    expect(first.isError).toBe(true);
    expect(textOf(first)).toMatch(/rejected the login/);
    expect(stub.logins()).toBe(1);

    // The retry a model makes after reading "check the password": the same
    // answer, marked as remembered, and no second line in the instance's log.
    const second = await userInfo(client);
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/rejected the login/);
    expect(textOf(second)).toMatch(/Repeated from memory/);
    expect(textOf(second)).toMatch(/next attempt is possible at/);
    expect(stub.logins()).toBe(1);

    vi.setSystemTime(Date.now() + LOGIN_COOLDOWN_MS + 1);
    const third = await userInfo(client);
    expect(textOf(third)).not.toMatch(/Repeated from memory/);
    expect(stub.logins()).toBe(2);
  });

  it('remembers a 503 as well — every refused login is a log line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const stub = stubLogin(() => new Response('', { status: 503 }));
    const client = await connect();
    await userInfo(client);
    const again = await userInfo(client);
    expect(textOf(again)).toMatch(/API as disabled/);
    expect(textOf(again)).toMatch(/Repeated from memory/);
    expect(stub.logins()).toBe(1);
  });

  it('does not extend the cooldown to the 401 retry of a request', async () => {
    // A cached token that the instance stops accepting earns one fresh login;
    // that login's refusal is what starts the cooldown, so the *next* tool
    // call is the one answered from memory.
    vi.useFakeTimers({ toFake: ['Date'] });
    let broken = false;
    const stub = stubLogin(
      () =>
        broken
          ? new Response('', { status: 401 })
          : new Response('Auth=tester/abc\n'),
      () => (broken ? new Response('', { status: 401 }) : new Response('{}'))
    );
    const client = await connect();
    expect((await userInfo(client)).isError).toBeFalsy();
    expect(stub.logins()).toBe(1);

    broken = true;
    const result = await userInfo(client);
    expect(textOf(result)).toMatch(/rejected the login/);
    expect(textOf(result)).not.toMatch(/Repeated from memory/);
    expect(stub.logins()).toBe(2);

    const next = await userInfo(client);
    expect(textOf(next)).toMatch(/Repeated from memory/);
    expect(stub.logins()).toBe(2);
  });
});

describe('L-2: tokens from the instance have a shape', () => {
  it('refuses an Auth line undici would quote back into the model context', async () => {
    stubLogin(() => new Response(`Auth=ab${CR}cd\n`));
    const client = await connect();
    const result = await userInfo(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/without a usable Auth token/);
    expect(textOf(result)).not.toMatch(/invalid header value/);
    expect(textOf(result)).not.toContain(CR);
  });

  it('refuses a token of megabytes and one of NULs', () => {
    expect(parseClientLogin(`Auth=${'a'.repeat(1025)}\n`)).toBeUndefined();
    expect(
      parseClientLogin(`Auth=ab${String.fromCharCode(0)}cd\n`)
    ).toBeUndefined();
    expect(parseClientLogin(`Auth=${'a'.repeat(1024)}\n`)).toBe(
      'a'.repeat(1024)
    );
    expect(parseClientLogin('Auth=tester/0123abcd\n')).toBe('tester/0123abcd');
  });

  it('refuses a write token that is not one', async () => {
    let logins = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/accounts/ClientLogin')) {
        logins++;
        return new Response('Auth=tester/abc\n');
      }
      if (path.endsWith('/reader/api/0/token')) {
        return new Response(`<html>${'x'.repeat(5000)}`);
      }
      return new Response('OK');
    });
    const client = await connect();
    const result = (await client.callTool({
      name: 'rename_category_or_label',
      arguments: { name: 'a', new_name: 'b' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not a write token/);
    expect(textOf(result)).not.toContain('<html>');
    expect(logins).toBe(1);
  });
});

describe('L-3: the status is decided before the body is read', () => {
  it('answers a 401 with a huge body as a 401, hint included, and still retries once', async () => {
    let reads = 0;
    const stub = stubLogin(
      () => new Response('Auth=tester/abc\n'),
      () => {
        reads++;
        return new Response('x'.repeat(1000), {
          status: 401,
          headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
        });
      }
    );
    const client = await connect();
    const result = await userInfo(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 401/);
    expect(textOf(result)).toMatch(/FRESHRSS_API_PASSWORD/);
    expect(textOf(result)).not.toMatch(/more than/);
    // The 401 retry: two reads, two logins.
    expect(reads).toBe(2);
    expect(stub.logins()).toBe(2);
  });

  it('cuts a five-megabyte error page instead of refusing the answer', async () => {
    stubFreshRss({
      '/user-info': () =>
        new Response(`nope ${'y'.repeat(5 * 1024 * 1024)}`, { status: 502 }),
    });
    const client = await connect();
    const result = await userInfo(client);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/HTTP 502/);
    expect(textOf(result)).toMatch(/untrusted text from the instance/);
    expect(textOf(result).length).toBeLessThan(3000);
  });
});

describe('L-4: mark_articles validates before it asks', () => {
  it('refuses an invalid id before any prompt or token', async () => {
    const stub = stubFreshRss({ '/edit-tag': 'OK' });
    const client = await connect({}, 'accept');
    const result = (await client.callTool({
      name: 'mark_articles',
      arguments: { article_ids: ['nope'], read: true },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/invalid article id/);
    expect(client.prompts).toHaveLength(0);
    expect(stub.readerCalls).toHaveLength(0);
  });

  it('binds the token to the validated ids, not to the spelling', async () => {
    const stub = stubFreshRss({ '/edit-tag': 'OK' });
    const client = await connect();
    const first = (await client.callTool({
      name: 'mark_articles',
      arguments: { article_ids: [' 12 ', '13'], read: true },
    })) as CallToolResult;
    const done = (await client.callTool({
      name: 'mark_articles',
      arguments: {
        article_ids: ['13', '12'],
        read: true,
        confirm_token: tokenOf(first),
      },
    })) as CallToolResult;
    expect(done.isError).toBeFalsy();
    expect(dataOf(done).articleIds).toEqual(['13', '12']);
    expect(stub.readerCalls).toHaveLength(1);
    expect(stub.readerCalls[0]?.form.getAll('i')).toEqual(['13', '12']);
  });
});

describe('L-5: the cleaning reaches every field', () => {
  it('cleans the feed titles get_unread_counts shows', async () => {
    stubFreshRss({
      '/subscription/list': JSON.stringify({
        subscriptions: [{ id: 'feed/1', title: `Ne${ESC}[31mws` }],
      }),
      '/unread-count': JSON.stringify({
        max: 3,
        unreadcounts: [{ id: 'feed/1', count: 3 }],
      }),
    });
    const client = await connect();
    const result = (await client.callTool({
      name: 'get_unread_counts',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(ESC);
    expect((dataOf(result).feeds as { title: string }[])[0]?.title).toBe(
      'Ne[31mws'
    );
  });

  it('strips control characters from the OPML export in both channels', async () => {
    const opml = `<opml><body><outline text="a${ESC}[2Jb" xmlUrl="https://f.example/"/></body></opml>`;
    stubFreshRss({ '/subscription/export': opml });
    const client = await connect();
    const result = (await client.callTool({
      name: 'export_opml',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).not.toContain(ESC);
    expect((result.structuredContent as { opml: string }).opml).not.toContain(
      ESC
    );
    expect((result.structuredContent as { opml: string }).opml).toContain(
      'text="a[2Jb"'
    );
  });

  it('turns a surrogate character reference and a lone surrogate into U+FFFD', () => {
    expect(htmlToText('a &#xD800; b &#55296; c', 100).text).toBe('a � b � c');
    expect(htmlToText(`x${LONE_SURROGATE}y`, 100).text).toBe('x�y');
    expect(cleanText(`x${LONE_SURROGATE}y`)).toBe('x�y');
    expect(upstreamText(`x${LONE_SURROGATE}y`)).toContain('x�y');
    // A pair split by the cut is a lone surrogate too.
    const cut = cleanText('ab😀', 3) as string;
    expect(cut.isWellFormed()).toBe(true);
    expect(htmlToText('ab😀', 3).text.isWellFormed()).toBe(true);
    expect(upstreamText('ab😀', 3).isWellFormed()).toBe(true);
  });
});

describe('L-6: the entity table is not an object', () => {
  it('leaves &constructor; and friends as the text they are', () => {
    for (const name of [
      'constructor',
      'hasOwnProperty',
      'toString',
      'valueOf',
    ]) {
      expect(htmlToText(`a &${name}; b`, 100).text).toBe(`a &${name}; b`);
    }
    expect(htmlToText('a &amp; &LT; b', 100).text).toBe('a & < b');
  });
});

describe('L-7: the import answer is quoted like every other', () => {
  it('labels and cleans what FreshRSS answered instead of OK', async () => {
    stubFreshRss({
      '/subscription/import': `Import failed ${ESC}[2J${'z'.repeat(500)}`,
    });
    const client = await connect();
    const result = await confirmed(client, 'import_opml', {
      opml: '<opml version="2.0"><body><outline text="x"/></body></opml>',
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/untrusted text from the instance/);
    expect(textOf(result)).not.toContain(ESC);
    expect(textOf(result).length).toBeLessThan(400);
  });
});

describe('L-8: the caller’s strings have ceilings', () => {
  it.each([
    ['list_articles', { since: 'x'.repeat(65) }],
    ['list_articles', { continuation: 'x'.repeat(257) }],
    ['list_articles', { category: 'x'.repeat(201) }],
    ['mark_all_as_read', { older_than: 'x'.repeat(65) }],
    ['get_articles', { article_ids: ['1'.repeat(65)] }],
    ['subscribe_feed', { url: `https://h.example/${'x'.repeat(8192)}` }],
    ['update_feed', { feed_id: 1, title: 'x'.repeat(1001) }],
    ['rename_category_or_label', { name: 'a', new_name: 'x'.repeat(201) }],
  ])('%s refuses %o at the schema', async (name, args) => {
    const stub = stubFreshRss({});
    const client = await connect();
    const outcome = await client
      .callTool({ name, arguments: args })
      .then((result) => result as CallToolResult)
      .catch((error: unknown) => error);
    if (outcome instanceof Error) {
      expect(outcome.message).toMatch(/64|256|200|1000|8192|too big|maximum/i);
    } else {
      expect((outcome as CallToolResult).isError).toBe(true);
    }
    expect(stub.readerCalls).toHaveLength(0);
  });
});

describe('L-10: the import is measured in the bytes FreshRSS reads', () => {
  it('refuses a document that grows past the FreshRSS ceiling when rewritten', async () => {
    lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
    const stub = stubFreshRss({ '/subscription/import': 'OK' });
    const client = await connect();
    // 300 000 characters as written; each `ü` becomes `%C3%BC` in the
    // canonical URL that is written back, so the document sent is 1.8 MB.
    const opml = `<opml version="2.0"><body><outline xmlUrl="https://h.example/${'ü'.repeat(300_000)}"/></body></opml>`;
    const result = (await client.callTool({
      name: 'import_opml',
      arguments: { opml },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/too large for FreshRSS/);
    expect(textOf(result)).toMatch(/1048576 bytes/);
    expect(textOf(result)).not.toMatch(/confirm_token/);
    expect(stub.readerCalls).toHaveLength(0);
  });
});

describe('L-11 and L-1: the configured URL', () => {
  const complete = {
    FRESHRSS_USER: 'tester',
    FRESHRSS_API_PASSWORD: 'secret',
  };

  it('drops trailing slashes in linear time', () => {
    const config = loadConfig({
      ...complete,
      FRESHRSS_URL: 'https://rss.example.com/sub///',
    } as NodeJS.ProcessEnv);
    expect(config.url).toBe('https://rss.example.com/sub');
    const started = performance.now();
    loadConfig({
      ...complete,
      FRESHRSS_URL: `https://rss.example.com/${'/'.repeat(200_000)}`,
    } as NodeJS.ProcessEnv);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it.each([
    ['s3cret-value-1234', /17-character value/],
    [`${'a1b2c3d4'.repeat(7)}:`, /57-character value/],
    ['not a url at all', /16-character value/],
  ])('describes %s without printing it', (raw, expected) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    expect(() =>
      loadConfig({ ...complete, FRESHRSS_URL: raw } as NodeJS.ProcessEnv)
    ).toThrow('exit');
    const line = String(error.mock.calls[0]?.[0] ?? '');
    expect(line).toMatch(expected);
    expect(line).not.toContain(raw.slice(0, 8));
  });

  it('still quotes a value that looks like a URL, redacted and cut', () => {
    expect(describeUrlValue('https://admin:s3cret@host:99999')).toBe(
      'https://***@host:99999'
    );
    expect(describeUrlValue(`ftp://${'h'.repeat(500)}`)).toHaveLength(121);
    expect(describeUrlValue(`https://h${ESC}ost`)).toBe('https://host');
  });
});

describe('L-12: get_user_info reads the instance’s strings as strings', () => {
  it('omits a number, cleans and cuts the rest, and passes the listed schema', async () => {
    stubFreshRss({
      '/user-info': JSON.stringify({
        userId: 5,
        userName: `te${ESC}[31mster`,
        userEmail: 'x'.repeat(500),
      }),
    });
    const client = await connect();
    const result = await userInfo(client);
    expect(result.isError).toBeFalsy();
    const data = dataOf(result);
    expect(data.userId).toBeUndefined();
    expect(data.userName).toBe('te[31mster');
    expect((data.userEmail as string).length).toBe(201);
  });
});

describe('M-2: the boundary decides the shape', () => {
  it('lists articles whose fields the instance typed wrongly', async () => {
    stubFreshRss({
      '/stream/contents/user/-/state/com.google/reading-list': JSON.stringify({
        items: [
          rawEntry({ origin: { streamId: 'feed/1e300', title: 'x' } }),
          rawEntry({ origin: { streamId: `feed/${'9'.repeat(20)}` } }),
          rawEntry({ published: 1e300 }),
          rawEntry({ published: -(2 ** 53) }),
          rawEntry({
            title: 42,
            author: null,
            categories: ['user/-/label/ok', 7, null],
            enclosure: [null, { href: 5 }, { href: 'https://e.example/a' }],
            summary: { content: 9 },
            canonical: 'nope',
            alternate: [null],
          }),
        ],
        continuation: 12,
      }),
    });
    const client = await connect();
    const result = (await client.callTool({
      name: 'list_articles',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const articles = dataOf(result).articles as Record<string, unknown>[];
    expect(articles).toHaveLength(5);
    const feedOf = (i: number): { id: unknown } =>
      (articles[i] as Record<string, unknown>).feed as { id: unknown };
    expect(feedOf(0).id).toBeNull();
    expect(feedOf(1).id).toBeNull();
    expect(articles[2]?.published).toBeUndefined();
    expect(articles[3]?.published).toBeUndefined();
    const odd = articles[4] as Record<string, unknown>;
    expect(odd.title).toBeUndefined();
    expect(odd.author).toBeUndefined();
    expect(odd.labels).toEqual(['ok']);
    expect(odd.enclosures).toEqual([{ url: 'https://e.example/a' }]);
    expect(odd.excerpt).toBeUndefined();
    expect(odd.url).toBeUndefined();
    expect(dataOf(result).continuation).toBeUndefined();
  });

  it.each([
    ['null', 'null'],
    ['a string', '"items"'],
    ['items that are not a list', '{"items": {"0": 1}}'],
    ['a number', '7'],
  ])('answers an empty listing for a body that is %s', async (_, body) => {
    stubFreshRss({
      '/stream/contents/user/-/state/com.google/reading-list': body,
    });
    const client = await connect();
    const result = (await client.callTool({
      name: 'list_articles',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(dataOf(result).articles).toEqual([]);
  });

  it('drops a continuation the input schema could not take back', async () => {
    stubFreshRss({
      '/stream/contents/user/-/state/com.google/reading-list': JSON.stringify({
        items: [],
        continuation: 'c'.repeat(257),
      }),
    });
    const client = await connect();
    const result = (await client.callTool({
      name: 'list_articles',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(dataOf(result).continuation).toBeUndefined();
    expect(JSON.stringify(dataOf(result).notes)).toMatch(
      /continuation value larger/
    );
  });

  it('survives 1e999 and a string where a count belongs, in every counting tool', async () => {
    stubFreshRss({
      '/subscription/list': JSON.stringify({
        subscriptions: [
          { id: 'feed/1', title: 'A', 'frss:priority': 7 },
          { id: 5, title: ['x'], url: 9, categories: 'nope' },
          null,
          'string',
        ],
      }),
      '/unread-count':
        '{"max": 1e999, "unreadcounts": [{"id": "feed/1", "count": 1e999}, {"id": "feed/2", "count": "3"}, null]}',
      '/tag/list': JSON.stringify({
        tags: [
          { id: 'user/-/label/Tech', type: 'folder', unread_count: 1e300 },
          null,
          { id: 3 },
        ],
      }),
    });
    const client = await connect();
    for (const name of ['list_feeds', 'get_unread_counts', 'list_categories']) {
      const result = (await client.callTool({
        name,
        arguments: {},
      })) as CallToolResult;
      expect(result.isError, name).toBeFalsy();
    }
    const feeds = (await client.callTool({
      name: 'list_feeds',
      arguments: {},
    })) as CallToolResult;
    const data = dataOf(feeds);
    expect(data.totalUnread).toBeUndefined();
    expect(data.feedCount).toBe(4);
    expect(
      (data.feeds as Record<string, unknown>[])[0]?.priority
    ).toBeUndefined();
    expect(
      (data.feeds as Record<string, unknown>[])[0]?.unreadCount
    ).toBeUndefined();
    expect((data.feeds as Record<string, unknown>[])[1]?.feedId).toBeNull();
    const counts = (await client.callTool({
      name: 'get_unread_counts',
      arguments: {},
    })) as CallToolResult;
    expect(dataOf(counts).totalUnread).toBe(0);
    expect(dataOf(counts).feeds).toEqual([]);
  });

  it('lists only ids that are strings of an id’s size', async () => {
    stubFreshRss({
      '/stream/items/ids': JSON.stringify({
        itemRefs: [{ id: 5 }, { id: 'ok' }, null, { id: 'x'.repeat(65) }],
      }),
    });
    const client = await connect();
    const result = (await client.callTool({
      name: 'list_article_ids',
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    expect(dataOf(result).articleIds).toEqual(['ok']);
    expect(dataOf(result).count).toBe(1);
  });

  it('keeps a feed id to fifteen digits, which is a safe integer by construction', () => {
    expect(feedIdFromStreamId('feed/123')).toBe(123);
    expect(feedIdFromStreamId(`feed/${'9'.repeat(15)}`)).toBe(
      999_999_999_999_999
    );
    expect(feedIdFromStreamId(`feed/${'9'.repeat(16)}`)).toBeNull();
    expect(feedIdFromStreamId('feed/1e3')).toBeNull();
    expect(feedIdFromStreamId('feed/-1')).toBeNull();
    expect(feedIdFromStreamId('feed/')).toBeNull();
    expect(feedIdFromStreamId(12)).toBeNull();
  });
});

describe('M-3: the publish job', () => {
  const release = readFileSync(
    new URL('../.github/workflows/release.yml', import.meta.url),
    'utf8'
  );

  it('installs without running install hooks while it holds the OIDC token', () => {
    const publish = release.slice(
      release.indexOf('  publish:'),
      release.indexOf('  mcp-registry:')
    );
    expect(publish).toContain('id-token: write');
    expect(publish).toContain('npm ci --ignore-scripts');
    expect(publish).not.toMatch(/npm ci\s*$/m);
  });

  it('creates the release only for a tag that exists', () => {
    expect(release).toContain('--verify-tag');
  });
});
