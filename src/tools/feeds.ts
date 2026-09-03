import { z } from 'zod';
import { feed, notes, record, untrustedFields } from '../output-schema.js';
import type { McpServer } from '@modelcontextprotocol/server';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  errorResult,
  jsonResult,
  ownWordsResult,
  run,
  ToolInputError,
} from '../result.js';
import {
  feedIdFromStreamId,
  labelFromStreamId,
  shapeSubscription,
  unreadCountIndex,
  UNTRUSTED_CONTENT_NOTE,
  type RawSubscription,
  type RawUnreadCount,
} from '../shape.js';

import { expectOk, SLOW_REQUEST_TIMEOUT_MS, type FreshRssApi } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { assertRoutableHosts } from '../hosts.js';
import { redactUrlCredentials } from '../redact.js';
import { assertFeedId, assertTagName } from '../streams.js';

interface SubscriptionListResponse {
  subscriptions?: RawSubscription[];
}

interface UnreadCountResponse {
  max?: number;
  unreadcounts?: RawUnreadCount[];
}

async function loadUnreadCounts(
  api: FreshRssApi
): Promise<UnreadCountResponse> {
  return (await api.getJson('/unread-count')) as UnreadCountResponse;
}

/**
 * Loads the unread counts, or `undefined` when that endpoint fails.
 *
 * In `list_feeds` and `list_categories` the counts are pure enrichment — one
 * optional field per row. A 500 from `/unread-count` must not cost the caller the
 * list it would otherwise have received. `get_unread_counts` does not use this:
 * there the counts *are* the answer.
 */
export async function loadUnreadCountsOptional(
  api: FreshRssApi
): Promise<UnreadCountResponse | undefined> {
  try {
    return await loadUnreadCounts(api);
  } catch {
    return undefined;
  }
}

/** Note added when the enrichment above was unavailable. */
export const UNREAD_COUNTS_UNAVAILABLE =
  'The unread counts could not be loaded, so unreadCount is missing; the rest of this result is complete.';

export function registerFeedReadTools(
  server: McpServer,
  api: FreshRssApi
): void {
  server.registerTool(
    'get_user_info',
    {
      title: 'Get user info',
      description:
        'Returns the FreshRSS account the server is authenticated as. Useful as a ' +
        'connection and credential check before anything else.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      // No untrusted marker: the account this server authenticates as.
      outputSchema: z.object({
        userId: z.string().optional(),
        userName: z.string().optional(),
        userEmail: z.string().optional(),
      }),
    },
    async () =>
      run(async () => {
        const data = (await api.getJson('/user-info')) as {
          userId?: string;
          userName?: string;
          userEmail?: string;
        };
        return jsonResult({
          userId: data.userId,
          userName: data.userName,
          userEmail: data.userEmail,
        });
      })
  );

  server.registerTool(
    'list_feeds',
    {
      title: 'List feeds',
      description:
        'Lists every subscribed feed with its category and unread count. The numeric ' +
        'feedId is what all other tools take as feed_id. Start here to find out what is ' +
        'subscribed before listing articles.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        feeds: z.array(feed),
        feedCount: z.number().int(),
        totalUnread: z.number().optional(),
        notes,
      }),
    },
    async () =>
      run(async () => {
        const [list, counts] = await Promise.all([
          api.getJson(
            '/subscription/list'
          ) as Promise<SubscriptionListResponse>,
          loadUnreadCountsOptional(api),
        ]);
        const unread = unreadCountIndex(counts?.unreadcounts ?? []);
        const feeds = (list.subscriptions ?? []).map((feed) =>
          shapeSubscription(feed, unread)
        );
        return jsonResult({
          feeds,
          feedCount: feeds.length,
          totalUnread: counts?.max,
          notes:
            counts === undefined
              ? [UNTRUSTED_CONTENT_NOTE, UNREAD_COUNTS_UNAVAILABLE]
              : [UNTRUSTED_CONTENT_NOTE],
        });
      })
  );

  server.registerTool(
    'get_unread_counts',
    {
      title: 'Get unread counts',
      description:
        'Returns how many unread articles are waiting, in total and per feed and ' +
        'category, sorted by count. Only entries with unread articles are listed.',
      inputSchema: z.object({}),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        totalUnread: z.number(),
        feeds: z.array(record),
        categoriesAndLabels: z
          .array(record)
          .describe('FreshRSS reports categories and user labels alike here.'),
        notes,
      }),
    },
    async () =>
      run(async () => {
        const [list, counts] = await Promise.all([
          api.getJson(
            '/subscription/list'
          ) as Promise<SubscriptionListResponse>,
          loadUnreadCounts(api),
        ]);
        const titles = new Map<number, string>();
        for (const feed of list.subscriptions ?? []) {
          const id = feedIdFromStreamId(feed.id);
          if (id !== null && feed.title !== undefined)
            titles.set(id, feed.title);
        }

        const feeds: {
          feedId: number;
          title: string | undefined;
          unread: number;
        }[] = [];
        const categories: { name: string; unread: number }[] = [];
        for (const entry of counts.unreadcounts ?? []) {
          if (entry.id === undefined || !entry.count) continue;
          const feedId = feedIdFromStreamId(entry.id);
          if (feedId !== null) {
            feeds.push({
              feedId,
              title: titles.get(feedId),
              unread: entry.count,
            });
            continue;
          }
          const label = labelFromStreamId(entry.id);
          if (label !== null)
            categories.push({ name: label, unread: entry.count });
        }
        feeds.sort((a, b) => b.unread - a.unread);
        categories.sort((a, b) => b.unread - a.unread);

        return jsonResult({
          totalUnread: counts.max ?? 0,
          feeds,
          // FreshRSS reports categories and user labels under the same key shape,
          // so this list holds both — see list_categories for the distinction.
          categoriesAndLabels: categories,
          notes: [UNTRUSTED_CONTENT_NOTE],
        });
      })
  );
}

export function registerFeedWriteTools(
  server: McpServer,
  api: FreshRssApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'subscribe_feed',
    {
      title: 'Subscribe to a feed',
      description:
        'Subscribes to a feed. The URL may point at the feed itself or at a website — ' +
        'FreshRSS discovers the feed and then downloads it, so this call can take a while. ' +
        'A category that does not exist yet is created.',
      inputSchema: z.object({
        url: z.string().describe('Feed URL or website URL (http/https)'),
        title: z
          .string()
          .optional()
          .describe("Title to use instead of the feed's own title"),
        category: z
          .string()
          .optional()
          .describe('Category to file the feed under; created if unknown'),
      }),
      // Stated rather than left to the default: this writes, but it only adds a
      // subscription, so it is not destructive. It is also not idempotent —
      // FreshRSS creates a second subscription for the same URL.
      annotations: {
        // Additive. Open-world: FreshRSS fetches the URL the caller supplies,
        // so the caller picks the address — the boundary the SSRF guard
        // watches. Not idempotent: FreshRSS accepts the same feed twice.
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
      outputSchema: z.object({
        feedId: z.number().int(),
        subscribed: z.literal(true),
        note: z.string(),
      }),
    },
    async ({ url, title, category }) =>
      run(async () => {
        const feedUrl = await assertHttpUrl(url);
        const result = (await api.getJson(
          '/subscription/quickadd',
          { quickadd: feedUrl },
          SLOW_REQUEST_TIMEOUT_MS
        )) as {
          numResults?: number;
          streamId?: string;
          error?: string;
        };
        // quickadd reports failures with HTTP 200 and numResults 0, so the status
        // code says nothing about whether the subscription happened.
        if (!result.numResults || result.streamId === undefined) {
          return errorResult(
            `FreshRSS could not subscribe to that URL: ${result.error ?? 'no feed found'}`
          );
        }
        const feedId = feedIdFromStreamId(result.streamId);
        if (feedId === null) {
          return errorResult(
            `FreshRSS returned an unexpected stream id for the new feed: ${result.streamId}`
          );
        }

        if (title !== undefined || category !== undefined) {
          await editSubscription(api, feedId, title, category);
        }
        return jsonResult({
          feedId,
          subscribed: true,
          note: 'Use list_feeds to see the feed with its resolved title and category.',
        });
      })
  );

  server.registerTool(
    'update_feed',
    {
      title: 'Update a feed',
      description:
        'Renames a feed and/or moves it to another category. A category that does not ' +
        'exist yet is created. Fields that are not given stay unchanged.',
      inputSchema: z.object({
        feed_id: z
          .number()
          .int()
          .positive()
          .describe('Numeric feedId from list_feeds'),
        title: z.string().optional().describe('New title'),
        category: z
          .string()
          .optional()
          .describe('Category to move the feed to'),
      }),
      // Overwrites the title and category, but nothing is deleted and applying
      // the same call twice leaves the same state.
      annotations: {
        // Replaces the title and category somebody chose.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        feedId: z.number().int(),
        updated: z.literal(true),
      }),
    },
    async ({ feed_id, title, category }) =>
      run(async () => {
        if (title === undefined && category === undefined) {
          return errorResult(
            'Nothing to change: set at least one of title or category.'
          );
        }
        await editSubscription(api, assertFeedId(feed_id), title, category);
        return ownWordsResult({ feedId: feed_id, updated: true });
      })
  );

  server.registerTool(
    'unsubscribe_feed',
    {
      title: 'Unsubscribe from a feed',
      description:
        'Deletes a feed together with all of its stored articles, read state and stars. ' +
        'Two-step: the first call returns a confirmation token, the second call with that ' +
        'token performs the deletion. This cannot be undone — re-subscribing starts from ' +
        'whatever the feed currently offers.',
      inputSchema: z.object({
        feed_id: z
          .number()
          .int()
          .positive()
          .describe('Numeric feedId from list_feeds'),
        confirm_token: z
          .string()
          .optional()
          .describe('Token from the first call of this tool'),
      }),
      annotations: {
        // Idempotent by the specification's wording — the second call fails,
        // but the world is the same either way. Every stored article of the
        // feed goes with it.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
      outputSchema: z.object({
        feedId: z.number().int(),
        unsubscribed: z.literal(true),
      }),
    },
    async ({ feed_id, confirm_token }, mcp) =>
      run(async () => {
        const feedId = assertFeedId(feed_id);
        const resource = setResourceKey('unsubscribe_feed', [String(feedId)]);

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            // Deliberately only the id in this text — never the feed title,
            // which comes from a third-party website.
            what: `delete feed ${feedId} and all of its stored articles`,
            consequence:
              'The subscription and every article FreshRSS stored for it are ' +
              'gone. Subscribing again fetches only what the feed still offers.',
            resourceKey: resource,
            token: confirm_token,
            toolName: 'unsubscribe_feed',
            hint: 'Tick to go ahead, leave it to cancel.',
          }
        );
        // A token that was sent and did not match is refused with the reason
        // rather than answered with a fresh prompt; the sentence is the
        // library's, so every server refuses in the same words.
        if (outcome.decision === 'rejected') {
          return errorResult(outcome.reason);
        }
        if (outcome.decision === 'declined') {
          return errorResult(
            `The user declined. unsubscribe_feed did nothing.`
          );
        }
        if (outcome.decision === 'pending') return outcome.result;

        const form = new URLSearchParams({
          ac: 'unsubscribe',
          s: `feed/${feedId}`,
        });
        expectOk(
          await api.postForm('/subscription/edit', form),
          `the deletion of feed ${feedId}`
        );
        return ownWordsResult({ feedId, unsubscribed: true });
      })
  );
}

async function editSubscription(
  api: FreshRssApi,
  feedId: number,
  title: string | undefined,
  category: string | undefined
): Promise<void> {
  const form = new URLSearchParams({ ac: 'edit', s: `feed/${feedId}` });
  if (title !== undefined) form.set('t', title);
  if (category !== undefined) {
    form.set('a', `user/-/label/${assertTagName(category, 'category')}`);
  }
  expectOk(
    await api.postForm('/subscription/edit', form),
    `the update of feed ${feedId}`
  );
}

/**
 * Validates the URL `quickadd` is about to be handed.
 *
 * `quickadd` is a server-side fetch: whatever arrives here is retrieved by the
 * FreshRSS server, stored, and read back out by `list_articles`. That makes this
 * tool an SSRF primitive, and it is reachable from injected text inside an
 * article — so the host is checked before the URL leaves this process.
 */
async function assertHttpUrl(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new ToolInputError(`invalid url: ${redactUrlCredentials(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolInputError(
      `invalid url: only http:// and https:// feeds can be subscribed (got ${parsed.protocol})`
    );
  }
  await assertRoutableHosts([parsed.hostname]);
  return parsed.toString();
}
