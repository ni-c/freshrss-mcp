/**
 * The tools this server can register, declared rather than discovered.
 *
 * Declared, because the tool filter has to answer "is this a name you have?"
 * *before* anything is registered — and in read-only mode the write tools are
 * never registered at all. Deriving the catalogue from what actually reached
 * `registerTool` would make `FRESHRSS_ALLOW_TOOLS=delete_category_or_label` report
 * "unknown tool" under `FRESHRSS_READ_ONLY=true`, which is the one answer that
 * is wrong.
 *
 * This is also the full tool surface, hard-coded on purpose: a tool that appears
 * or disappears by accident is a change to the server's contract and has to be a
 * deliberate edit here. `test/tool-filter.test.ts` asserts that these lists and
 * the tools the server really registers are the same set.
 */

/** Registered always. Every one carries `readOnlyHint: true`. */
export const READ_TOOLS = [
  'export_opml',
  'get_articles',
  'get_unread_counts',
  'get_user_info',
  'list_article_ids',
  'list_articles',
  'list_categories',
  'list_feeds',
] as const;

/** Registered unless `FRESHRSS_READ_ONLY` is set. */
export const WRITE_TOOLS = [
  'delete_category_or_label',
  'import_opml',
  'mark_all_as_read',
  'mark_articles',
  'rename_category_or_label',
  'subscribe_feed',
  'unsubscribe_feed',
  'update_feed',
] as const;

/** Every tool, read-only mode aside. */
export const ALL_TOOLS: readonly string[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * What `FRESHRSS_ALLOW_TOOLS=essential` selects: triage and read.
 *
 * 7 of 16. Left out on purpose: subscription management, OPML import/export and category renaming —
 * a different job from reading the feed.
 */
export const ESSENTIAL_TOOLS: readonly string[] = [
  'list_feeds',
  'list_categories',
  'get_unread_counts',
  'list_articles',
  'get_articles',
  'mark_articles',
  'mark_all_as_read',
];
