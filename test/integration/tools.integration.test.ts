import {
  expectEveryToolDeclaresOutputSchema,
  expectEveryToolExercised,
  startServer,
  toolCoverage,
  tokenOf,
  type LiveHarness,
} from 'mcp-integration-harness';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ALL_TOOLS,
  READ_TOOLS,
  WRITE_TOOLS,
} from '../../src/tools/catalogue.js';
import {
  bootstrap,
  FEED_TITLE,
  FEED_URL,
  MARKER,
  type Sandbox,
} from './bootstrap.js';

/**
 * Every tool in the catalogue, against a real FreshRSS in Docker.
 *
 * The unit tests stub the GReader endpoints, which is where the interesting
 * part is: GReader is a protocol FreshRSS *reimplements*, and the places where
 * its reimplementation differs from what the documentation implies are exactly
 * what a stub cannot show. Two of those are asserted below — an article id is
 * a long-form string on the wire whose *decimal* value is what the write
 * endpoints want, and FreshRSS answers `OK` to a mark request whether or not
 * it recognised the ids, so a wrong conversion is completely silent.
 *
 * Order matters and state is shared: the feed subscribed at the top is
 * renamed, read, marked and finally unsubscribed at the bottom.
 */

let sandbox: Sandbox;
/** Declares elicitation, so guarded tools go through the real dialog. */
let asking: LiveHarness;
/** Declares none, so the same tools fall back to the two-call token. */
let plain: LiveHarness;

let feedId: number;
let articleIds: string[];

function parse<T>(text: string): T {
  const start = text.search(/[[{]/);
  if (start === -1) throw new Error(`no JSON in result: ${text.slice(0, 300)}`);
  return JSON.parse(text.slice(start)) as T;
}

interface Feeds {
  feeds: { feedId: number; title: string; category?: string }[];
}

interface Counts {
  totalUnread: number;
  feeds: { feedId: number; title: string; unread: number }[];
  categoriesAndLabels: { name: string; unread: number }[];
}

beforeAll(async () => {
  sandbox = await bootstrap();
  asking = await startServer({ env: sandbox.env, elicit: 'accept' });
  plain = await startServer({ env: sandbox.env });
}, 600_000);

afterAll(async () => {
  await asking?.close();
  await plain?.close();
});

describe('the account', () => {
  it('reports who the API password belongs to', async () => {
    const info = await asking.call('get_user_info');
    expect(info).toContain('integration');
    // The API password must not come back out.
    expect(info).not.toContain('integration-api-not-a-secret');
  });
});

describe('a feed through its whole life', () => {
  it('subscribes to one on the compose network', async () => {
    await asking.call('subscribe_feed', {
      url: FEED_URL,
      title: FEED_TITLE,
      category: 'Integration',
    });

    const feeds = parse<Feeds>(await asking.call('list_feeds'));
    const feed = feeds.feeds.find((f) => f.title === FEED_TITLE);
    expect(feed).toBeDefined();
    feedId = feed!.feedId;
  });

  it('files it under the category it was given', async () => {
    const categories = await asking.call('list_categories');
    expect(categories).toContain('Integration');
  });

  it('renames the category', async () => {
    await asking.call('rename_category_or_label', {
      name: 'Integration',
      new_name: 'Integration Renamed',
    });
    expect(await asking.call('list_categories')).toContain(
      'Integration Renamed'
    );
  });

  it('renames the feed itself', async () => {
    await asking.call('update_feed', {
      feed_id: feedId,
      title: 'Integration Feed Renamed',
    });
    const feeds = parse<Feeds>(await asking.call('list_feeds'));
    expect(feeds.feeds.map((f) => f.title)).toContain(
      'Integration Feed Renamed'
    );
  });
});

describe('reading what the feed brought', () => {
  it('lists the articles, with the content the fixture put there', async () => {
    const listed = await asking.call('list_articles', {
      feed_id: feedId,
      include_content: true,
    });
    expect(listed).toContain('First integration article');
    expect(listed).toContain(MARKER);
  });

  it('lists the ids in the form the write tools want', async () => {
    // The trap GReader has and its documentation does not spell out: on the
    // wire an id is `tag:google.com,2005:reader/item/<16 hex digits>`, and the
    // endpoints that change things want the **decimal** value of those digits.
    // This server converts, so what comes out here is already decimal — and
    // the proof that the conversion is right is the unread count moving in the
    // next block, not this assertion.
    const ids = parse<{ articleIds: string[]; count: number }>(
      await asking.call('list_article_ids', { feed_id: feedId })
    );
    articleIds = ids.articleIds;
    expect(articleIds).toHaveLength(3);
    for (const id of articleIds) expect(id).toMatch(/^\d+$/);
  });

  it('fetches specific articles by id', async () => {
    const fetched = await asking.call('get_articles', {
      article_ids: articleIds.slice(0, 2),
    });
    expect(fetched).toContain('integration article');
  });

  it('counts what is unread, per feed and per category', async () => {
    const counts = parse<Counts>(await asking.call('get_unread_counts'));
    expect(counts.feeds.find((f) => f.feedId === feedId)?.unread).toBe(3);
    expect(
      counts.categoriesAndLabels.find((c) => c.name === 'Integration Renamed')
        ?.unread
    ).toBe(3);
  });
});

describe('marking things read', () => {
  it('marks two articles, and the unread count follows', async () => {
    await asking.call('mark_articles', {
      article_ids: articleIds.slice(0, 2),
      read: true,
    });

    const after = parse<Counts>(await asking.call('get_unread_counts'));
    // The whole point of the id conversion, and the only assertion that can
    // prove it: FreshRSS answers `OK` to a mark request whether or not it
    // recognised the ids, so a wrong conversion is silent. The count is the
    // only thing that moves.
    expect(after.feeds.find((f) => f.feedId === feedId)?.unread).toBe(1);
  });

  it('marks a whole stream read, which is not a list of ids', async () => {
    await asking.call('mark_all_as_read', { feed_id: feedId });
    const after = parse<Counts>(await asking.call('get_unread_counts'));
    // The feed drops out of the list entirely once nothing in it is unread,
    // rather than appearing with a zero.
    const feed = after.feeds.find((f) => f.feedId === feedId);
    expect(feed?.unread ?? 0).toBe(0);
  });
});

describe('OPML', () => {
  it('exports what is subscribed, and imports it back', async () => {
    const exported = await asking.call('export_opml');
    expect(exported).toContain('Integration Feed Renamed');

    // Importing the same document is a no-op that must not duplicate the
    // feeds — which is only checkable against a real subscription list.
    const before = parse<Feeds>(await asking.call('list_feeds')).feeds.length;
    const opml = exported.slice(exported.indexOf('<?xml'));
    await asking.call('import_opml', { opml });
    const after = parse<Feeds>(await asking.call('list_feeds')).feeds.length;
    expect(after).toBe(before);
  });
});

describe('the fallback path for a client with no dialog', () => {
  it('deletes a category only after the token comes back', async () => {
    // The prompt is an error result: nothing was deleted, which is what
    // `isError` says — and a tool that declares an `outputSchema` may not
    // answer without `structuredContent` unless the result is an error.
    const refusal = await plainPrompt('delete_category_or_label', {
      name: 'Integration Renamed',
    });
    expect(refusal).toContain('confirm_token');
    expect(plain.prompts).toHaveLength(0);
    expect(await plain.call('list_categories')).toContain(
      'Integration Renamed'
    );

    await plain.call('delete_category_or_label', {
      name: 'Integration Renamed',
      confirm_token: tokenOf(refusal),
    });
    expect(await plain.call('list_categories')).not.toContain(
      'Integration Renamed'
    );
  });

  it('unsubscribes only after the token comes back', async () => {
    const refusal = await plainPrompt('unsubscribe_feed', { feed_id: feedId });
    expect(refusal).toContain('confirm_token');

    await plain.call('unsubscribe_feed', {
      feed_id: feedId,
      confirm_token: tokenOf(refusal),
    });
    const feeds = parse<Feeds>(await plain.call('list_feeds'));
    expect(feeds.feeds.map((f) => f.feedId)).not.toContain(feedId);
  });

  it('asked a person on one harness and nobody on the other', () => {
    expect(asking.prompts.length).toBeGreaterThan(0);
    expect(plain.prompts).toHaveLength(0);
  });
});

describe('what the server refuses to do to a real FreshRSS', () => {
  /**
   * Refusals asserted with their reason, never with a bare `expectError: true`.
   *
   * A guard test that only asserts "something failed" goes green for the wrong
   * reasons — a renamed argument, a 500, a schema change — and keeps doing so
   * after the guard it is named for has stopped being reached. These are the
   * paths where FreshRSS would make the server-side request, so the message has
   * to be the SSRF refusal and not merely a failure.
   */
  it('will not point FreshRSS at its own loopback interface', async () => {
    await asking.call(
      'subscribe_feed',
      { url: 'http://127.0.0.1:8081/rss' },
      { expectError: /loopback and link-local/ }
    );
  });

  it('will not import an OPML document aimed at the metadata service', async () => {
    await asking.call(
      'import_opml',
      {
        opml:
          '<?xml version="1.0"?><opml version="2.0"><body>' +
          '<outline text="f" xmlUrl="http://169.254.169.254/latest/meta-data/"/>' +
          '</body></opml>',
      },
      { expectError: /loopback and link-local/ }
    );
    // Refused before anything was confirmed, so no token was handed out for a
    // document that was never going to be imported.
    expect(asking.prompts.join('\n')).not.toContain('169.254.169.254');
  });

  it('registers no write tool at all when the read-only switch is on', async () => {
    // Spelled `1` on purpose. The switch used to be read as `=== 'true'`, so
    // every other spelling an operator plausibly writes started a server with
    // the full write surface and said nothing about it.
    const readOnly = await startServer({
      env: { ...sandbox.env, FRESHRSS_READ_ONLY: '1' },
    });
    try {
      const { tools } = await readOnly.client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining([...READ_TOOLS]));
      for (const write of WRITE_TOOLS) expect(names).not.toContain(write);
    } finally {
      await readOnly.close();
    }
  });
});

/** A guarded tool's first call: the confirmation prompt, which is an error. */
async function plainPrompt(
  name: string,
  args: Record<string, unknown> = {}
): Promise<string> {
  return plain.call(name, args, { expectError: /confirm_token=/ });
}

it('declares an output schema on every tool', async () => {
  // The unit suite checks the same thing against a stub. Here it is checked
  // against the server that has just answered every one of these tools against
  // a real FreshRSS — and each of those answers went through the SDK's
  // validation against the schema below it.
  const { tools } = await asking.client.listTools();
  expectEveryToolDeclaresOutputSchema(tools);
});

it('exercises every tool in the catalogue', () => {
  const called = new Set([...asking.called, ...plain.called]);
  const report = toolCoverage({ called }, ALL_TOOLS, {});
  console.log(
    `freshrss-mcp: ${report.called.length}/${ALL_TOOLS.length} tools against a real FreshRSS`
  );
  expectEveryToolExercised({ called }, ALL_TOOLS, {});
});
