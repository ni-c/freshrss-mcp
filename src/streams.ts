import { ToolInputError } from './result.js';

/** The special streams FreshRSS exposes besides feeds, categories and labels. */
export const SPECIAL_STREAMS = {
  'reading-list': 'user/-/state/com.google/reading-list',
  starred: 'user/-/state/com.google/starred',
  main: 'user/-/state/org.freshrss/main',
  important: 'user/-/state/org.freshrss/important',
} as const;

export type SpecialStream = keyof typeof SPECIAL_STREAMS;

/** Where a listing tool should read from. Exactly one field may be set. */
export interface StreamSelector {
  feed_id?: number | undefined;
  category?: string | undefined;
  label?: string | undefined;
  stream?: SpecialStream | undefined;
}

/**
 * Resolves the selector into a Google Reader stream id.
 *
 * Categories and labels share one namespace in the API (`user/-/label/<name>`);
 * FreshRSS looks for a category first and falls back to a label. The two
 * separate parameters exist only so the tool description can stay
 * understandable — they resolve identically.
 */
export function resolveStream(selector: StreamSelector): {
  streamId: string;
  description: string;
} {
  const given = [
    selector.feed_id !== undefined && 'feed_id',
    selector.category !== undefined && 'category',
    selector.label !== undefined && 'label',
    selector.stream !== undefined && 'stream',
  ].filter((v): v is string => Boolean(v));

  if (given.length > 1) {
    throw new ToolInputError(
      `Set only one of feed_id, category, label or stream (got: ${given.join(', ')}).`
    );
  }

  if (selector.feed_id !== undefined) {
    return {
      streamId: `feed/${assertFeedId(selector.feed_id)}`,
      description: `feed ${selector.feed_id}`,
    };
  }
  if (selector.category !== undefined) {
    return {
      streamId: `user/-/label/${assertTagName(selector.category, 'category')}`,
      description: 'the selected category',
    };
  }
  if (selector.label !== undefined) {
    return {
      streamId: `user/-/label/${assertTagName(selector.label, 'label')}`,
      description: 'the selected label',
    };
  }
  const stream = selector.stream ?? 'reading-list';
  return { streamId: SPECIAL_STREAMS[stream], description: `stream ${stream}` };
}

/**
 * Turns a stream id into the path segments of `/stream/contents/<streamId>`.
 *
 * The name part is percent-encoded: FreshRSS pulls the label out of the raw
 * REQUEST_URI with a regular expression and url-decodes it afterwards, so an
 * unencoded space or slash would silently address a different stream.
 */
export function streamContentsPath(streamId: string): string {
  const label = streamId.startsWith('user/-/label/')
    ? streamId.slice('user/-/label/'.length)
    : undefined;
  if (label !== undefined) {
    return `/stream/contents/user/-/label/${encodeURIComponent(label)}`;
  }
  return `/stream/contents/${streamId}`;
}

/** Feed ids are FreshRSS row ids; anything else would address a foreign feed. */
export function assertFeedId(id: number): number {
  if (!Number.isInteger(id) || id <= 0) {
    throw new ToolInputError(
      `invalid feed_id: ${id}. Use the numeric feedId returned by list_feeds.`
    );
  }
  return id;
}

/**
 * Guards a category or label name.
 *
 * Deliberately not the scaffold's `assertPathSegment`: FreshRSS category names
 * legitimately contain spaces, umlauts and punctuation. What must not pass is a
 * slash (it would add a path segment and change which endpoint is addressed)
 * or a control character.
 */
export function assertTagName(name: string, what: string): string {
  const trimmed = name.trim();
  if (trimmed === '') {
    throw new ToolInputError(`the ${what} name must not be empty`);
  }
  if (trimmed.includes('/')) {
    throw new ToolInputError(
      `invalid ${what} name: it must not contain a slash`
    );
  }
  // `encodeURIComponent('..')` is `..`, so a dot segment survives into the path
  // and the URL parser then removes the segment above it — addressing a
  // different endpoint instead of a label. Slashes are blocked above, so this is
  // the only remaining way to move within the path.
  if (trimmed === '.' || trimmed === '..') {
    throw new ToolInputError(
      `invalid ${what} name: "." and ".." are not valid names`
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new ToolInputError(
      `invalid ${what} name: it must not contain control characters`
    );
  }
  if (trimmed.length > 200) {
    throw new ToolInputError(`invalid ${what} name: it is too long`);
  }
  return trimmed;
}

const ITEM_TAG_PREFIX = 'tag:google.com,2005:reader/item/';

/**
 * Converts the item id of an API response into the decimal form the write
 * endpoints expect.
 *
 * FreshRSS reports ids as `tag:google.com,2005:reader/item/<16 hex digits>` but
 * `edit-tag` matches on the decimal row id. Values exceed 2^53, so this goes
 * through BigInt — parsing them as numbers loses the last digits and would edit
 * a different article.
 */
export function itemIdToDecimal(id: string): string {
  const raw = id.startsWith(ITEM_TAG_PREFIX)
    ? id.slice(ITEM_TAG_PREFIX.length)
    : id;
  if (/^[0-9]+$/.test(raw) && !raw.startsWith('0')) return raw;
  if (!/^[0-9a-fA-F]+$/.test(raw)) {
    // Truncated: this value comes from the *response*, so a hostile or
    // compromised instance would otherwise choose a string that lands in an
    // error message the model reads.
    throw new ToolInputError(
      `unexpected article id from FreshRSS: ${id.slice(0, 80)}`
    );
  }
  return BigInt(`0x${raw}`).toString(10);
}

/** Validates an article id supplied by the caller. */
export function assertArticleId(id: string): string {
  const trimmed = id.trim();
  if (/^[0-9]+$/.test(trimmed)) return trimmed;
  if (trimmed.startsWith(ITEM_TAG_PREFIX)) return itemIdToDecimal(trimmed);
  throw new ToolInputError(
    `invalid article id: ${trimmed}. Use the decimal id returned by list_articles or list_article_ids.`
  );
}

/**
 * Parses an ISO-8601 date (or a bare unix timestamp) into unix **seconds**,
 * which is what the `ot`/`nt` parameters of the stream endpoints use.
 */
export function toUnixSeconds(value: string, what: string): number {
  const trimmed = value.trim();
  if (/^[0-9]{1,10}$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new ToolInputError(
      `invalid ${what}: "${value}". Use an ISO-8601 date such as 2026-08-17 or 2026-08-17T09:00:00Z.`
    );
  }
  return Math.floor(parsed / 1000);
}

/**
 * Converts a date into the `ts` value of `mark-all-as-read`, in **microseconds**.
 *
 * The Google Reader documentation and FreshRSS' own source comment call this
 * parameter "nanoseconds", but the value is compared against the entry id
 * (`WHERE id <= ?`) and FreshRSS entry ids are microsecond timestamps. Passing
 * nanoseconds would mark the entire stream as read regardless of the date.
 */
export function toEntryIdMicroseconds(value: string, what: string): string {
  return `${toUnixSeconds(value, what)}000000`;
}
