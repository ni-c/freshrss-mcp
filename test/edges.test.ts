import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/client';

import { expectOk } from '../src/api.js';
import { jsonResult, textResult } from '../src/result.js';
import { createServer } from '../src/server.js';
import { rawEntry, stubFreshRss, testConfig } from './helpers.js';

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
  return JSON.stringify(result.content);
}

/** The unescaped text of the first content block. */
function rawText(result: CallToolResult): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('no text content');
  return first.text;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('jsonResult', () => {
  it('passes a normal payload through as pretty JSON', () => {
    const result = jsonResult({ a: 1 });
    expect(rawText(result)).toMatch(/"a": 1/);
  });

  it('drops article text when the payload is pathologically large', () => {
    // Backstop behind the per-tool budgets: a single FreshRSS article can be
    // half a megabyte, so the result builder must be able to shed content.
    const articles = Array.from({ length: 20 }, () => ({
      id: '1',
      content: 'x'.repeat(50_000),
    }));
    const text = JSON.stringify(jsonResult({ articles }).content);
    expect(text).toMatch(/result too large/);
    expect(text.length).toBeLessThan(200_000);
  });
});

describe('expectOk', () => {
  it('accepts the plain OK body FreshRSS answers with', () => {
    expect(() => expectOk('OK\n', 'the change')).not.toThrow();
  });

  it('rejects anything else and quotes a bounded part of it', () => {
    expect(() => expectOk('x'.repeat(500), 'the change')).toThrow(/…/);
  });
});

describe('textResult', () => {
  it('wraps plain text', () => {
    expect(textResult('hi').content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('tool edge cases', () => {
  it('get_user_info returns the account', async () => {
    stubFreshRss({
      '/user-info': JSON.stringify({
        userId: 'tester',
        userName: 'tester',
        userEmail: 'tester@example.com',
      }),
    });
    const result = (await (
      await connect()
    ).callTool({ name: 'get_user_info', arguments: {} })) as CallToolResult;
    expect(textOf(result)).toMatch(/tester@example.com/);
  });

  it('update_feed refuses a call that would change nothing', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'update_feed',
      arguments: { feed_id: 12 },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('update_feed renames without touching the category', async () => {
    const stub = stubFreshRss({ '/subscription/edit': 'OK' });
    await (
      await connect()
    ).callTool({
      name: 'update_feed',
      arguments: { feed_id: 12, title: 'Renamed' },
    });
    const call = stub.readerCalls[0];
    expect(call?.form.get('t')).toBe('Renamed');
    expect(call?.form.get('a')).toBeNull();
  });

  it('unsubscribe_feed rejects a token that was never issued', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'unsubscribe_feed',
      arguments: { feed_id: 12, confirm_token: 'deadbeef' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('subscribe_feed reports an unexpected stream id instead of guessing', async () => {
    stubFreshRss({
      '/subscription/quickadd': JSON.stringify({
        numResults: 1,
        streamId: 'user/-/label/News',
      }),
    });
    const result = (await (
      await connect()
    ).callTool({
      name: 'subscribe_feed',
      arguments: { url: 'https://news.example.com/rss' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/unexpected stream id/);
  });

  it('subscribe_feed rejects a malformed URL', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'subscribe_feed',
      arguments: { url: 'not a url' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('list_article_ids returns bare ids and the continuation', async () => {
    const stub = stubFreshRss({
      '/stream/items/ids': JSON.stringify({
        itemRefs: [{ id: '1725750242384960' }, { id: '1725750242384959' }],
        continuation: '1725750242384959',
      }),
    });
    const result = (await (
      await connect()
    ).callTool({
      name: 'list_article_ids',
      arguments: { feed_id: 12, filter: 'all' },
    })) as CallToolResult;

    const url = new URL(stub.readerCalls[0]?.url ?? '');
    expect(url.searchParams.get('s')).toBe('feed/12');
    // filter "all" must not send an it= at all, otherwise nothing matches.
    expect(url.searchParams.get('it')).toBeNull();
    expect(rawText(result)).toMatch(/"count": 2/);
  });

  it('list_articles returns the article text when asked for it', async () => {
    stubFreshRss({
      '/stream/contents/user/-/state/com.google/starred': JSON.stringify({
        items: [rawEntry()],
      }),
    });
    const result = (await (
      await connect()
    ).callTool({
      name: 'list_articles',
      arguments: { stream: 'starred', include_content: true },
    })) as CallToolResult;
    expect(textOf(result)).toMatch(/Hello world\./);
    expect(textOf(result)).toMatch(/untrusted data/);
  });

  it('list_articles rejects an unparsable since date before any request', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'list_articles',
      arguments: { since: 'yesterday' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('rename_category_or_label refuses a no-op rename', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'rename_category_or_label',
      arguments: { name: 'News', new_name: ' News ' },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('mark_articles rejects a label containing a slash', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'mark_articles',
      arguments: {
        article_ids: ['1725750242384960'],
        add_labels: ['a/b'],
      },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(stub.calls).toHaveLength(0);
  });

  it('import_opml refuses a document larger than FreshRSS will read', async () => {
    const stub = stubFreshRss();
    const result = (await (
      await connect()
    ).callTool({
      name: 'import_opml',
      arguments: { opml: `<opml>${'x'.repeat(900_000)}</opml>` },
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/too large/);
    expect(stub.calls).toHaveLength(0);
  });

  it('import_opml reports a body that is not OK', async () => {
    const stub = stubFreshRss({ '/subscription/import': 'Bad Request!' });
    const client = await connect();
    const args = { opml: '<opml><outline/></opml>' };
    const first = (await client.callTool({
      name: 'import_opml',
      arguments: args,
    })) as CallToolResult;
    const token = /confirm_token=\\?"([0-9a-f]+)/.exec(textOf(first))?.[1];
    const second = (await client.callTool({
      name: 'import_opml',
      arguments: { ...args, confirm_token: token },
    })) as CallToolResult;
    expect(second.isError).toBe(true);
    expect(stub.readerCalls).toHaveLength(1);
  });

  it('export_opml truncates a huge document', async () => {
    stubFreshRss({
      '/subscription/export': () =>
        new Response('<opml>'.padEnd(300_000, 'x'), { status: 200 }),
    });
    const result = (await (
      await connect()
    ).callTool({ name: 'export_opml', arguments: {} })) as CallToolResult;
    expect(textOf(result)).toMatch(/truncated at 200000 characters/);
  });

  it('reports a non-JSON body as a wrong base URL', async () => {
    stubFreshRss({
      '/user-info': () =>
        new Response('<html>FreshRSS</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const result = (await (
      await connect()
    ).callTool({ name: 'get_user_info', arguments: {} })) as CallToolResult;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/root of the FreshRSS instance/);
  });
});
