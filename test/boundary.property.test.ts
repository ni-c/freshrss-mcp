/**
 * What the instance's JSON can be, fed through the whole server.
 *
 * Every read tool declares an output schema, and on SDK 2.0 the server checks
 * its own `structuredContent` against it before answering: a violation is an
 * `isError` result with the text "Output validation error" and no cause — and
 * a *listing* loses every good element because of one bad one. `JSON.parse`
 * turns `1e999` into `Infinity`, a missing field into `undefined`, and the
 * instance can write a number where a title belongs. This test feeds each tool
 * both arbitrary JSON and envelopes of the right shape with arbitrary leaves,
 * and asserts the answer is never a crash and never a schema violation.
 *
 * `SHAPE_RUNS=300 npx vitest run test/boundary.property.test.ts` for a deep
 * local run; CI keeps the count small.
 */
import type { CallToolResult } from '@modelcontextprotocol/client';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { connect, stubFreshRss, textOf } from './harness.js';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup }));

const RUNS = {
  numRuns: Number(process.env.SHAPE_RUNS ?? '25'),
};

afterEach(() => {
  vi.restoreAllMocks();
  lookup.mockReset();
});

/** Spliced into the serialised text where JSON.stringify could not write it. */
const INFINITY = '__INFINITY__';

/** A value the instance might put in any field. */
const leaf = fc.oneof(
  { weight: 3, arbitrary: fc.string({ maxLength: 40 }) },
  fc.string({ unit: 'binary', maxLength: 700 }),
  fc.double({ noNaN: true }),
  fc.integer(),
  fc.constant(1e300),
  fc.constant(-(2 ** 53)),
  fc.constant(2 ** 53),
  fc.constant(-0),
  fc.constant(null),
  fc.constant(true),
  fc.constant(INFINITY),
  fc.constant('constructor'),
  fc.constant('__proto__'),
  fc.jsonValue({ maxDepth: 2 })
);

/** A leaf, or a value that is right for the field, so the good paths run too. */
function mostly<T>(good: fc.Arbitrary<T>): fc.Arbitrary<unknown> {
  return fc.oneof({ weight: 2, arbitrary: good }, leaf);
}

const streamId = mostly(
  fc.oneof(
    fc.integer({ min: 1, max: 99_999 }).map((n) => `feed/${n}`),
    fc.constant('feed/1e300'),
    fc.constant(`feed/${'9'.repeat(20)}`),
    fc.string({ maxLength: 20 }).map((s) => `user/-/label/${s}`)
  )
);

const itemId = mostly(
  fc.oneof(
    fc.constant('tag:google.com,2005:reader/item/0006218f8a2b1c40'),
    fc.integer({ min: 1 }).map(String)
  )
);

const entry = fc.record(
  {
    id: itemId,
    title: leaf,
    author: leaf,
    published: mostly(fc.integer({ min: 0, max: 2_000_000_000 })),
    canonical: mostly(fc.array(fc.record({ href: leaf }), { maxLength: 2 })),
    alternate: leaf,
    categories: mostly(
      fc.array(
        fc.oneof(
          fc.constant('user/-/state/com.google/read'),
          fc.constant('user/-/state/com.google/starred'),
          fc.constant('user/-/label/News'),
          leaf
        ),
        { maxLength: 4 }
      )
    ),
    origin: mostly(fc.record({ streamId, title: leaf, htmlUrl: leaf })),
    summary: mostly(fc.record({ content: leaf })),
    content: leaf,
    enclosure: mostly(
      fc.array(fc.record({ href: leaf, type: leaf }), { maxLength: 2 })
    ),
  },
  { requiredKeys: [] }
);

const stream = fc.record(
  { items: mostly(fc.array(entry, { maxLength: 3 })), continuation: leaf },
  { requiredKeys: [] }
);

const subscriptions = fc.record(
  {
    subscriptions: mostly(
      fc.array(
        fc.record(
          {
            id: streamId,
            title: leaf,
            url: leaf,
            htmlUrl: leaf,
            categories: mostly(
              fc.array(fc.record({ id: leaf, label: leaf }), { maxLength: 2 })
            ),
            'frss:priority': leaf,
          },
          { requiredKeys: [] }
        ),
        { maxLength: 3 }
      )
    ),
  },
  { requiredKeys: [] }
);

const unreadCounts = fc.record(
  {
    max: leaf,
    unreadcounts: mostly(
      fc.array(fc.record({ id: streamId, count: leaf }), { maxLength: 3 })
    ),
  },
  { requiredKeys: [] }
);

const tags = fc.record(
  {
    tags: mostly(
      fc.array(
        fc.record(
          {
            id: streamId,
            type: mostly(fc.constantFrom('folder', 'tag')),
            unread_count: leaf,
          },
          { requiredKeys: [] }
        ),
        { maxLength: 3 }
      )
    ),
  },
  { requiredKeys: [] }
);

const itemRefs = fc.record(
  {
    itemRefs: mostly(
      fc.array(fc.record({ id: itemId }, { requiredKeys: [] }), {
        maxLength: 3,
      })
    ),
    continuation: leaf,
  },
  { requiredKeys: [] }
);

const userInfo = fc.record(
  { userId: leaf, userName: leaf, userEmail: leaf },
  { requiredKeys: [] }
);

const quickadd = fc.record(
  { numResults: leaf, streamId, error: leaf },
  { requiredKeys: [] }
);

/** The body as the instance would send it, `1e999` included. */
function serialise(value: unknown): string {
  return JSON.stringify(value).replaceAll(`"${INFINITY}"`, '1e999');
}

/** Any of the shaped envelopes, or arbitrary JSON. */
function bodyOf(shaped: fc.Arbitrary<unknown>): fc.Arbitrary<string> {
  return fc
    .oneof({ weight: 4, arbitrary: shaped }, fc.jsonValue({ maxDepth: 3 }))
    .map(serialise);
}

const CRASHES = [
  'Output validation error',
  'Cannot read properties',
  'is not a function',
  'Invalid time value',
  'is not iterable',
  'invalid header value',
  'RangeError',
];

function expectNoCrash(result: CallToolResult, body: string): void {
  const text = textOf(result);
  for (const marker of CRASHES) {
    expect(text, `${marker} for ${body.slice(0, 200)}`).not.toContain(marker);
  }
}

interface Case {
  tool: string;
  args: Record<string, unknown>;
  routes: Record<string, fc.Arbitrary<unknown>>;
  /** Error texts the tool is allowed to answer with, on purpose. */
  allowed: RegExp[];
}

const CASES: Case[] = [
  {
    tool: 'list_articles',
    args: { include_content: true },
    routes: {
      '/stream/contents/user/-/state/com.google/reading-list': stream,
    },
    allowed: [/unexpected article id/],
  },
  {
    tool: 'get_articles',
    args: { article_ids: ['12'] },
    routes: { '/stream/items/contents': stream },
    allowed: [/unexpected article id/],
  },
  {
    tool: 'list_article_ids',
    args: {},
    routes: { '/stream/items/ids': itemRefs },
    allowed: [],
  },
  {
    tool: 'list_feeds',
    args: {},
    routes: {
      '/subscription/list': subscriptions,
      '/unread-count': unreadCounts,
    },
    allowed: [],
  },
  {
    tool: 'get_unread_counts',
    args: {},
    routes: {
      '/subscription/list': subscriptions,
      '/unread-count': unreadCounts,
    },
    allowed: [],
  },
  {
    tool: 'list_categories',
    args: {},
    routes: { '/tag/list': tags, '/unread-count': unreadCounts },
    allowed: [],
  },
  {
    tool: 'get_user_info',
    args: {},
    routes: { '/user-info': userInfo },
    allowed: [],
  },
  {
    tool: 'subscribe_feed',
    args: { url: 'https://feeds.example.com/rss' },
    routes: { '/subscription/quickadd': quickadd },
    allowed: [/could not subscribe/, /unexpected stream id/],
  },
];

describe('every read tool, on whatever the instance sends', () => {
  it.each(CASES.map((c) => [c.tool, c] as const))(
    '%s never crashes and never breaks its own schema',
    async (_, { tool, args, routes, allowed }) => {
      lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const paths = Object.keys(routes);
      const bodies = fc.tuple(
        ...paths.map((p) => bodyOf(routes[p] as fc.Arbitrary<unknown>))
      );
      await fc.assert(
        fc.asyncProperty(bodies, async (answers) => {
          vi.restoreAllMocks();
          const table: Record<string, string> = {};
          paths.forEach((p, i) => {
            table[p] = answers[i] as string;
          });
          stubFreshRss(table);
          const client = await connect();
          const result = (await client.callTool({
            name: tool,
            arguments: args,
          })) as CallToolResult;
          const body = answers.join(' | ');
          expectNoCrash(result, body);
          if (result.isError) {
            const text = textOf(result);
            expect(
              allowed.some((pattern) => pattern.test(text)),
              `unexpected error for ${body.slice(0, 300)}: ${text.slice(0, 300)}`
            ).toBe(true);
          }
          await client.close();
        }),
        RUNS
      );
    }
  );
});
