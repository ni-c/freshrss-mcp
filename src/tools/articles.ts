import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { setResourceKey } from 'mcp-approval';
import type { Approver, ConfirmationStore } from 'mcp-approval';
import {
  Notes,
  shapeEntry,
  type EntryOptions,
  type RawEntry,
} from '../shape.js';
import {
  assertArticleId,
  assertTagName,
  itemIdToDecimal,
  resolveStream,
  streamContentsPath,
  toEntryIdMicroseconds,
  toUnixSeconds,
  type StreamSelector,
} from '../streams.js';

import { expectOk, type FreshRssApi } from '../api.js';
import { READ_ONLY } from './annotations.js';
import { errorResult, jsonResult, run, textResult } from '../result.js';

/** Articles per call. FreshRSS itself defaults to 20 and has no upper bound. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Articles whose full text can be fetched in one `get_articles` call. */
const MAX_GET_ARTICLES = 20;
/** Articles that can be edited in one `mark_articles` call. */
const MAX_EDIT_ARTICLES = 100;
const DEFAULT_MAX_CONTENT_CHARS = 2000;
const MAX_CONTENT_CHARS = 20_000;
/** Characters of article text across one response, whatever the per-article cap. */
const TOTAL_CONTENT_BUDGET = 60_000;

const READ_STATE = 'user/-/state/com.google/read';
const STARRED_STATE = 'user/-/state/com.google/starred';
const LABEL_PREFIX = 'user/-/label/';

const selectorSchema = {
  feed_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('Numeric feedId from list_feeds'),
  category: z
    .string()
    .optional()
    .describe('Category (folder) name exactly as returned by list_categories'),
  label: z
    .string()
    .optional()
    .describe('User label name exactly as returned by list_categories'),
  stream: z
    .enum(['reading-list', 'starred', 'main', 'important'])
    .optional()
    .describe(
      'Built-in stream: reading-list = everything (default), starred = favourites, ' +
        'main = feeds shown on the main stream, important = feeds marked important'
    ),
};

const listingSchema = {
  ...selectorSchema,
  filter: z
    .enum(['unread', 'read', 'starred', 'all'])
    .optional()
    .describe('Read state to return, default unread'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Maximum number of articles, default ${DEFAULT_LIMIT}`),
  order: z
    .enum(['newest', 'oldest'])
    .optional()
    .describe('Sort order by publication date, default newest'),
  since: z
    .string()
    .optional()
    .describe('Only articles published after this ISO-8601 date'),
  until: z
    .string()
    .optional()
    .describe('Only articles published before this ISO-8601 date'),
  continuation: z
    .string()
    .optional()
    .describe(
      'Continuation value from a previous call, to fetch the next page'
    ),
};

function selectorOf(args: Record<string, unknown>): StreamSelector {
  return {
    feed_id: args.feed_id as number | undefined,
    category: args.category as string | undefined,
    label: args.label as string | undefined,
    stream: args.stream as StreamSelector['stream'],
  };
}

/** Maps the `filter` argument onto the `it` parameter of the stream endpoints. */
function filterTarget(filter: string | undefined): string | undefined {
  switch (filter ?? 'unread') {
    case 'unread':
      return 'user/-/state/com.google/unread';
    case 'read':
      return READ_STATE;
    case 'starred':
      return STARRED_STATE;
    default:
      return undefined;
  }
}

function listingParams(args: {
  filter?: string | undefined;
  limit?: number | undefined;
  order?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  continuation?: string | undefined;
}): Record<string, string | number | undefined> {
  return {
    n: args.limit ?? DEFAULT_LIMIT,
    r: args.order === 'oldest' ? 'o' : 'd',
    it: filterTarget(args.filter),
    ot:
      args.since === undefined ? undefined : toUnixSeconds(args.since, 'since'),
    nt:
      args.until === undefined ? undefined : toUnixSeconds(args.until, 'until'),
    c: args.continuation,
  };
}

interface StreamResponse {
  items?: RawEntry[];
  continuation?: string;
}

function shapeItems(
  items: RawEntry[],
  options: EntryOptions
): { articles: unknown[]; notes: string[] } {
  const notes = new Notes();
  const budget = { left: options.totalContentBudget };
  const articles = items.map((item) =>
    shapeEntry(item, itemIdToDecimal, options, budget, notes)
  );
  return { articles, notes: notes.list() };
}

export function registerArticleReadTools(
  server: McpServer,
  api: FreshRssApi
): void {
  server.registerTool(
    'list_articles',
    {
      title: 'List articles',
      description:
        'Lists articles from a feed, category, label or built-in stream, newest first. ' +
        'Returns short plain-text excerpts by default; set include_content=true for the ' +
        'article text, or fetch single articles with get_articles. ' +
        'FreshRSS has no full-text search over its API, so there is no way to query by ' +
        'keyword — narrow the result with feed_id/category and since/until instead and ' +
        'filter the returned articles yourself.',
      inputSchema: z.object({
        ...listingSchema,
        include_content: z
          .boolean()
          .optional()
          .describe('Return the article text instead of a short excerpt'),
        max_content_chars: z
          .number()
          .int()
          .min(100)
          .max(MAX_CONTENT_CHARS)
          .optional()
          .describe(
            `Characters of article text per article, default ${DEFAULT_MAX_CONTENT_CHARS}`
          ),
      }),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { streamId } = resolveStream(selectorOf(args));
        const data = (await api.getJson(
          streamContentsPath(streamId),
          listingParams(args)
        )) as StreamResponse;

        const { articles, notes } = shapeItems(data.items ?? [], {
          includeContent: args.include_content === true,
          maxContentChars: args.max_content_chars ?? DEFAULT_MAX_CONTENT_CHARS,
          totalContentBudget: TOTAL_CONTENT_BUDGET,
        });
        const emptyHint = emptyResultHint(articles.length, selectorOf(args));
        return jsonResult({
          articles,
          continuation: data.continuation,
          ...(data.continuation !== undefined
            ? {
                moreAvailable:
                  'Call list_articles again with this continuation value for the next page.',
              }
            : {}),
          ...(emptyHint === undefined ? {} : { hint: emptyHint }),
          ...(notes.length > 0 ? { notes } : {}),
        });
      })
  );

  server.registerTool(
    'get_articles',
    {
      title: 'Get articles',
      description:
        'Fetches the full text of specific articles by id, as plain text. ' +
        `At most ${MAX_GET_ARTICLES} ids per call.`,
      inputSchema: z.object({
        article_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_GET_ARTICLES)
          .describe('Article ids as returned by list_articles'),
        max_content_chars: z
          .number()
          .int()
          .min(100)
          .max(MAX_CONTENT_CHARS)
          .optional()
          .describe(
            `Characters of article text per article, default ${DEFAULT_MAX_CONTENT_CHARS}`
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ article_ids, max_content_chars }) =>
      run(async () => {
        const form = new URLSearchParams();
        for (const id of article_ids) form.append('i', assertArticleId(id));
        const data = (await api.postFormJson(
          '/stream/items/contents',
          form
        )) as StreamResponse;

        const { articles, notes } = shapeItems(data.items ?? [], {
          includeContent: true,
          maxContentChars: max_content_chars ?? DEFAULT_MAX_CONTENT_CHARS,
          totalContentBudget: TOTAL_CONTENT_BUDGET,
        });
        const missing = article_ids.length - articles.length;
        return jsonResult({
          articles,
          ...(missing > 0
            ? {
                note: `${missing} of the requested ids returned no article; they may have been purged by the FreshRSS retention settings.`,
              }
            : {}),
          ...(notes.length > 0 ? { notes } : {}),
        });
      })
  );

  server.registerTool(
    'list_article_ids',
    {
      title: 'List article ids',
      description:
        'Lists only the ids of matching articles — the cheap way to collect a set for ' +
        'mark_articles. Same selectors and filters as list_articles.',
      inputSchema: z.object(listingSchema),
      annotations: READ_ONLY,
    },
    async (args) =>
      run(async () => {
        const { streamId } = resolveStream(selectorOf(args));
        const data = (await api.getJson('/stream/items/ids', {
          ...listingParams(args),
          s: streamId,
        })) as { itemRefs?: { id?: string }[]; continuation?: string };

        const articleIds = (data.itemRefs ?? [])
          .map((ref) => ref.id)
          .filter((id): id is string => id !== undefined);
        const emptyHint = emptyResultHint(articleIds.length, selectorOf(args));
        return jsonResult({
          articleIds,
          count: articleIds.length,
          continuation: data.continuation,
          ...(emptyHint === undefined ? {} : { hint: emptyHint }),
        });
      })
  );
}

export function registerArticleWriteTools(
  server: McpServer,
  api: FreshRssApi,
  confirmations: ConfirmationStore,
  approval: Approver
): void {
  server.registerTool(
    'mark_articles',
    {
      title: 'Mark articles',
      description:
        'Sets the read state, the star and user labels of specific articles. ' +
        'All changes are reversible by calling this tool again with the opposite value. ' +
        `At most ${MAX_EDIT_ARTICLES} articles per call; every given change is applied to ` +
        'all of them.',
      inputSchema: z.object({
        article_ids: z
          .array(z.string())
          .min(1)
          .max(MAX_EDIT_ARTICLES)
          .describe('Article ids as returned by list_articles'),
        read: z
          .boolean()
          .optional()
          .describe('true marks as read, false marks as unread'),
        starred: z
          .boolean()
          .optional()
          .describe('true adds the star (favourite), false removes it'),
        add_labels: z
          .array(z.string())
          .optional()
          .describe('User labels to attach; unknown labels are created'),
        remove_labels: z
          .array(z.string())
          .optional()
          .describe('User labels to detach'),
      }),
      // Deliberately not confirmation-gated, unlike mark_all_as_read: the caller
      // names every article explicitly and at most 100 of them, and each field
      // can be set back. What is *not* recoverable is the per-article prior
      // state, so this is declared destructive and a client may prompt for it.
      annotations: {
        // Destructive despite being a marker: FreshRSS keeps no record of
        // which articles were unread, so this cannot be undone as an
        // operation. Idempotent — marking a read article read changes nothing.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ article_ids, read, starred, add_labels, remove_labels }) =>
      run(async () => {
        const add: string[] = [];
        const remove: string[] = [];
        if (read === true) add.push(READ_STATE);
        if (read === false) remove.push(READ_STATE);
        if (starred === true) add.push(STARRED_STATE);
        if (starred === false) remove.push(STARRED_STATE);
        for (const label of add_labels ?? []) {
          add.push(`${LABEL_PREFIX}${assertTagName(label, 'label')}`);
        }
        for (const label of remove_labels ?? []) {
          remove.push(`${LABEL_PREFIX}${assertTagName(label, 'label')}`);
        }
        if (add.length === 0 && remove.length === 0) {
          return errorResult(
            'Nothing to change: set at least one of read, starred, add_labels or remove_labels.'
          );
        }

        const form = new URLSearchParams();
        for (const id of article_ids) form.append('i', assertArticleId(id));
        for (const value of add) form.append('a', value);
        for (const value of remove) form.append('r', value);

        expectOk(
          await api.postForm('/edit-tag', form),
          'the change of the article states'
        );
        return textResult(
          `Updated ${article_ids.length} article(s): ${describeChanges(read, starred, add_labels, remove_labels)}.`
        );
      })
  );

  server.registerTool(
    'mark_all_as_read',
    {
      title: 'Mark all as read',
      description:
        'Marks every article of a feed, category, label or built-in stream as read. ' +
        'Two-step: the first call returns a confirmation token, the second call with that ' +
        'token performs the change. Which articles were unread before cannot be recovered ' +
        'afterwards.',
      inputSchema: z.object({
        ...selectorSchema,
        older_than: z
          .string()
          .optional()
          .describe(
            'Only articles published before this ISO-8601 date; default: all of them'
          ),
        confirm_token: z
          .string()
          .optional()
          .describe('Token from the first call of this tool'),
      }),
      annotations: {
        // The same, over a whole selection.
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args, mcp) =>
      run(async () => {
        const { streamId, description } = resolveStream(selectorOf(args));
        const olderThan =
          args.older_than === undefined
            ? '0'
            : toEntryIdMicroseconds(args.older_than, 'older_than');
        const resource = setResourceKey('mark_all_as_read', [
          streamId,
          olderThan,
        ]);

        const outcome = await approval.requestApproval(
          server,
          mcp,
          confirmations,
          {
            what:
              `mark every article in ${description} as read` +
              (args.older_than === undefined
                ? ''
                : ' that is older than the given date'),
            consequence:
              'FreshRSS keeps no record of which articles were unread, so this ' +
              'cannot be undone for the selection as a whole.',
            resourceKey: resource,
            token: args.confirm_token,
            toolName: 'mark_all_as_read',
            hint: 'Tick to mark them read, leave it to cancel.',
          }
        );
        // A token that was sent and did not match is refused with the reason
        // rather than answered with a fresh prompt; the sentence is the
        // library's, so every server refuses in the same words.
        if (outcome.decision === 'rejected') {
          return errorResult(outcome.reason);
        }
        if (outcome.decision === 'declined') {
          return errorResult('The user declined. Nothing was marked as read.');
        }
        if (outcome.decision === 'pending') return outcome.result;

        // `ts` is documented as nanoseconds but is compared against the entry id,
        // and FreshRSS entry ids are microsecond timestamps — see
        // toEntryIdMicroseconds. Nanoseconds would ignore older_than entirely.
        const form = new URLSearchParams({ s: streamId, ts: olderThan });
        expectOk(
          await api.postForm('/mark-all-as-read', form),
          'marking the stream as read'
        );
        return textResult(`Marked ${description} as read.`);
      })
  );
}

/**
 * Explains an empty listing when the selector could simply be misspelled.
 *
 * Verified against FreshRSS 1.29.1: a category, label or feed id that does not
 * exist returns HTTP 200 with an empty `items` array, *not* an error — only a
 * malformed built-in stream id produces 400. So the most likely mistake, a
 * mistyped name, is indistinguishable from "nothing unread" unless it is said
 * out loud. Without this a model reports "you have no unread articles in News"
 * when the category is actually called "news".
 */
export function emptyResultHint(
  count: number,
  selector: StreamSelector
): string | undefined {
  if (count > 0) return undefined;
  if (selector.category !== undefined || selector.label !== undefined) {
    return (
      'No articles matched. Note that FreshRSS returns an empty list rather than an ' +
      'error for a category or label that does not exist, and names are matched ' +
      'literally including case — confirm the name with list_categories. Otherwise ' +
      'the filter (default: unread) or the date range may simply exclude everything.'
    );
  }
  if (selector.feed_id !== undefined) {
    return (
      'No articles matched. Note that FreshRSS returns an empty list rather than an ' +
      'error for a feed id that does not exist — confirm the id with list_feeds. ' +
      'Otherwise the filter (default: unread) or the date range may simply exclude ' +
      'everything.'
    );
  }
  return undefined;
}

/**
 * Summarises what was changed. Uses only the caller's own arguments — never a
 * title or feed name coming back from the API, which is third-party text.
 */
function describeChanges(
  read: boolean | undefined,
  starred: boolean | undefined,
  addLabels: string[] | undefined,
  removeLabels: string[] | undefined
): string {
  const parts: string[] = [];
  if (read !== undefined) parts.push(read ? 'read' : 'unread');
  if (starred !== undefined) parts.push(starred ? 'starred' : 'unstarred');
  if (addLabels?.length) parts.push(`added ${addLabels.length} label(s)`);
  if (removeLabels?.length)
    parts.push(`removed ${removeLabels.length} label(s)`);
  return parts.join(', ');
}
