/**
 * The annotation block every reading tool of this server carries, and the rule
 * the writing ones follow.
 *
 * Written out rather than left to the defaults, because the defaults are not
 * neutral: the specification says `destructiveHint` and `openWorldHint` both
 * default to **true**, so an omitted field is the *stronger* claim. A tool that
 * says nothing is a destructive tool in an open world.
 *
 * The line this family draws for `destructiveHint`:
 *
 *   **Content that a person wrote, replaced with no way back — destructive.**
 *   **A setting, a state or a marker, changed — not destructive.**
 *
 * A read state is a marker by that rule, and yet `mark_articles` and
 * `mark_all_as_read` are destructive here. The reason is what FreshRSS keeps:
 * nothing. There is no record of which articles were unread, so marking a
 * thousand of them read cannot be undone as an operation — only guessed at,
 * article by article. imap-mcp reaches the opposite answer for
 * `set_message_flags` and is right to: IMAP flags come back off.
 *
 * `openWorldHint`: false, except where the caller names an address FreshRSS
 * then fetches — `subscribe_feed` and `import_opml`. That is the same boundary
 * the SSRF guard watches.
 */
export const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
