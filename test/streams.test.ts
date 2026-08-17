import { describe, expect, it } from 'vitest';

import {
  assertArticleId,
  assertFeedId,
  assertTagName,
  itemIdToDecimal,
  resolveStream,
  streamContentsPath,
  toEntryIdMicroseconds,
  toUnixSeconds,
} from '../src/streams.js';

describe('resolveStream', () => {
  it('defaults to the reading list', () => {
    expect(resolveStream({}).streamId).toBe(
      'user/-/state/com.google/reading-list'
    );
  });

  it('maps the built-in streams', () => {
    expect(resolveStream({ stream: 'starred' }).streamId).toBe(
      'user/-/state/com.google/starred'
    );
    expect(resolveStream({ stream: 'important' }).streamId).toBe(
      'user/-/state/org.freshrss/important'
    );
  });

  it('maps feeds, categories and labels', () => {
    expect(resolveStream({ feed_id: 12 }).streamId).toBe('feed/12');
    expect(resolveStream({ category: 'News' }).streamId).toBe(
      'user/-/label/News'
    );
    expect(resolveStream({ label: 'later' }).streamId).toBe(
      'user/-/label/later'
    );
  });

  it('rejects more than one selector', () => {
    expect(() => resolveStream({ feed_id: 1, category: 'News' })).toThrow(
      /only one of/
    );
  });

  it('rejects a non-numeric feed id', () => {
    expect(() => assertFeedId(0)).toThrow(/invalid feed_id/);
    expect(() => assertFeedId(1.5)).toThrow(/invalid feed_id/);
  });
});

describe('streamContentsPath', () => {
  it('percent-encodes a label name', () => {
    // FreshRSS extracts the name from the raw request URI with a regular
    // expression and url-decodes it; an unencoded space would address a
    // different stream (or none).
    expect(streamContentsPath('user/-/label/Nachrichten DE')).toBe(
      '/stream/contents/user/-/label/Nachrichten%20DE'
    );
  });

  it('leaves feed and state streams alone', () => {
    expect(streamContentsPath('feed/12')).toBe('/stream/contents/feed/12');
    expect(streamContentsPath('user/-/state/com.google/starred')).toBe(
      '/stream/contents/user/-/state/com.google/starred'
    );
  });
});

describe('assertTagName', () => {
  it('accepts names with spaces and umlauts', () => {
    expect(assertTagName('Nachrichten Übersicht', 'category')).toBe(
      'Nachrichten Übersicht'
    );
  });

  it('trims', () => {
    expect(assertTagName('  News  ', 'category')).toBe('News');
  });

  it('rejects an empty name', () => {
    expect(() => assertTagName('   ', 'category')).toThrow(/must not be empty/);
  });

  it('rejects a slash, which would change the addressed endpoint', () => {
    expect(() => assertTagName('a/b', 'category')).toThrow(/slash/);
    expect(() => assertTagName('../../token', 'category')).toThrow(/slash/);
  });

  it('rejects control characters', () => {
    expect(() => assertTagName('a\nb', 'category')).toThrow(/control/);
    expect(() => assertTagName('a\u0007b', 'category')).toThrow(/control/);
  });

  it('rejects an absurdly long name', () => {
    expect(() => assertTagName('x'.repeat(201), 'category')).toThrow(
      /too long/
    );
  });
});

describe('article ids', () => {
  it('converts the hexadecimal tag form to decimal', () => {
    expect(
      itemIdToDecimal('tag:google.com,2005:reader/item/0006218f8a2b1c40')
    ).toBe('1725750242384960');
  });

  it('survives values beyond 2^53', () => {
    // Parsed as a Number this would lose the low digits and edit a different
    // article, so the conversion has to go through BigInt.
    const id = itemIdToDecimal(
      'tag:google.com,2005:reader/item/7fffffffffffffff'
    );
    expect(id).toBe('9223372036854775807');
    // Going through Number would round the value and address a different article.
    expect(String(Number(id))).not.toBe(id);
  });

  it('passes a decimal id through unchanged', () => {
    expect(itemIdToDecimal('1725750242384960')).toBe('1725750242384960');
  });

  it('rejects garbage', () => {
    expect(() => itemIdToDecimal('not-an-id')).toThrow(/unexpected article id/);
  });

  it('accepts both forms as tool input', () => {
    expect(assertArticleId(' 1725750242384960 ')).toBe('1725750242384960');
    expect(
      assertArticleId('tag:google.com,2005:reader/item/0006218f8a2b1c40')
    ).toBe('1725750242384960');
    expect(() => assertArticleId('12; DROP')).toThrow(/invalid article id/);
  });
});

describe('date conversion', () => {
  it('parses ISO dates into unix seconds', () => {
    expect(toUnixSeconds('2026-08-17T00:00:00Z', 'since')).toBe(1786924800);
  });

  it('passes a bare unix timestamp through', () => {
    expect(toUnixSeconds('1786924800', 'since')).toBe(1786924800);
  });

  it('rejects an unparsable date', () => {
    expect(() => toUnixSeconds('last tuesday', 'since')).toThrow(
      /invalid since/
    );
  });

  it('converts to microseconds for mark-all-as-read, not nanoseconds', () => {
    // FreshRSS compares `ts` against the entry id, and entry ids are microsecond
    // timestamps. Nanoseconds would be larger than every id and mark the whole
    // stream as read regardless of the date.
    expect(toEntryIdMicroseconds('2026-08-17T00:00:00Z', 'older_than')).toBe(
      '1786924800000000'
    );
  });
});
