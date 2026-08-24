import { describe, expect, it } from 'vitest';

import {
  htmlToText,
  Notes,
  shapeEntry,
  shapeSubscription,
  unreadCountIndex,
  type EntryOptions,
  type RawEntry,
} from '../src/shape.js';
import { itemIdToDecimal } from '../src/streams.js';
import { rawEntry } from './helpers.js';

const options: EntryOptions = {
  includeContent: false,
  maxContentChars: 2000,
  totalContentBudget: 60_000,
};

function shape(
  entry: Record<string, unknown>,
  overrides: Partial<EntryOptions> = {},
  budget = { left: 60_000 }
): Record<string, unknown> {
  return shapeEntry(
    entry as RawEntry,
    itemIdToDecimal,
    { ...options, ...overrides },
    budget,
    new Notes()
  );
}

describe('htmlToText', () => {
  it('turns markup into readable plain text', () => {
    expect(htmlToText('<p>Hello <b>world</b>.</p>', 100).text).toBe(
      'Hello world.'
    );
  });

  it('drops script and style bodies', () => {
    const html =
      '<style>p{color:red}</style><p>Text</p><script>evil()</script>';
    expect(htmlToText(html, 100).text).toBe('Text');
  });

  it('keeps paragraph and line breaks', () => {
    expect(htmlToText('<p>One</p><p>Two</p>', 100).text).toBe('One\nTwo');
    expect(htmlToText('a<br>b', 100).text).toBe('a\nb');
  });

  it('decodes entities', () => {
    expect(htmlToText('AT&amp;T &#8364;5 &nbsp;&hellip;', 100).text).toBe(
      'AT&T €5 …'
    );
  });

  it('does not let a numeric entity smuggle in control characters', () => {
    expect(htmlToText('a&#0;b', 100).text).toBe('a b');
  });

  // Entities decode to angle brackets, and that happens after the tag pass. Any
  // encoding of "<script>" therefore used to reappear as markup in the output.
  it.each([
    ['named', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['decimal', '&#60;script&#62;alert(1)&#60;/script&#62;'],
    ['hexadecimal', '&#x3c;script&#x3e;alert(1)&#x3c;/script&#x3e;'],
  ])('does not let a %s entity rebuild a script tag', (_name, encoded) => {
    const { text } = htmlToText(`<p>${encoded}</p>`, 500);
    expect(text).not.toMatch(/<script/i);
    expect(text).not.toContain('alert(1)');
  });

  it('does not let an entity rebuild an event handler attribute', () => {
    const { text } = htmlToText(
      '<p>&lt;img src=x onerror=alert(1)&gt;</p>',
      500
    );
    expect(text).not.toMatch(/<img/i);
    expect(text).not.toContain('onerror');
  });

  it('leaves doubly encoded markup as the text it is', () => {
    // One decoding pass yields "&lt;b&gt;", which is text and not a tag. The
    // markup pass must not keep chewing until that becomes one.
    expect(htmlToText('<p>&amp;lt;b&amp;gt;</p>', 500).text).toBe('&lt;b&gt;');
  });

  it('drops a script body whose closing tag never arrives', () => {
    const { text } = htmlToText('<p>Text</p><script>var a=1; evil();', 500);
    expect(text).toBe('Text');
  });

  it('drops an unterminated tag at the end of the input', () => {
    expect(htmlToText('<p>Text</p><script src=x', 500).text).toBe('Text');
  });

  // The price of the rule above: a bare "<" followed by a letter at the very end
  // of the text goes with it. Consistent with the rest of the function — "x<y>z"
  // has always come out as "xz" — and preferable to letting tag fragments through.
  it('also drops a trailing angle bracket that was meant literally', () => {
    expect(htmlToText('<p>if x&lt;y</p>', 500).text).toBe('if x');
    // Only at the end, and only before a letter: ordinary comparisons survive.
    expect(htmlToText('<p>if x &lt; y then z</p>', 500).text).toBe(
      'if x < y then z'
    );
  });

  it('truncates at the limit and says so', () => {
    const result = htmlToText(`<p>${'x'.repeat(500)}</p>`, 50);
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(51); // 50 characters plus the ellipsis
  });

  it('reports truncation when the input was longer than the parsed slice', () => {
    // The parser only looks at a bounded slice of the markup; the result must
    // not claim to be complete just because the visible part fits.
    const html = `<span>${'<i></i>'.repeat(20_000)}</span>`;
    expect(htmlToText(html, 100).truncated).toBe(true);
  });
});

describe('shapeEntry', () => {
  it('returns the decimal id and the article metadata', () => {
    const shaped = shape(rawEntry());
    expect(shaped.id).toBe('1725750242384960');
    expect(shaped.title).toBe('A headline');
    expect(shaped.author).toBe('Jane Doe');
    expect(shaped.url).toBe('https://news.example.com/a');
    expect(shaped.published).toBe('2025-08-17T00:00:00.000Z');
    expect(shaped.feed).toEqual({ id: 12, title: 'Example News' });
  });

  it('turns the category stream ids into states and labels', () => {
    const shaped = shape(
      rawEntry({
        categories: [
          'user/-/state/com.google/reading-list',
          'user/-/state/com.google/read',
          'user/-/state/com.google/starred',
          'user/-/state/org.freshrss/important',
          'user/-/label/News',
          'user/-/label/later',
        ],
      })
    );
    expect(shaped.read).toBe(true);
    expect(shaped.starred).toBe(true);
    expect(shaped.priority).toBe('important');
    expect(shaped.labels).toEqual(['News', 'later']);
  });

  it('defaults to unread, unstarred and normal priority', () => {
    const shaped = shape(
      rawEntry({ categories: ['user/-/state/com.google/reading-list'] })
    );
    expect(shaped.read).toBe(false);
    expect(shaped.starred).toBe(false);
    expect(shaped.priority).toBe('normal');
    expect(shaped.labels).toBeUndefined();
  });

  it('returns an excerpt, not the content, by default', () => {
    const shaped = shape(
      rawEntry({ summary: { content: `<p>${'x'.repeat(5000)}</p>` } })
    );
    expect(shaped.content).toBeUndefined();
    expect(String(shaped.excerpt)).toHaveLength(301);
    expect(shaped.excerptTruncated).toBe(true);
  });

  it('returns bounded content when asked for it', () => {
    const shaped = shape(
      rawEntry({ summary: { content: `<p>${'x'.repeat(5000)}</p>` } }),
      { includeContent: true, maxContentChars: 500 }
    );
    expect(String(shaped.content)).toHaveLength(501);
    expect(shaped.contentTruncated).toBe(true);
  });

  it('stops emitting content once the response budget is spent', () => {
    // The guarantee that matters: FreshRSS returns up to 500 000 characters per
    // article, so without a shared budget a listing of 20 blows up the context.
    const budget = { left: 400 };
    const first = shape(
      rawEntry({ summary: { content: `<p>${'x'.repeat(5000)}</p>` } }),
      { includeContent: true, maxContentChars: 2000 },
      budget
    );
    const second = shape(
      rawEntry({ summary: { content: `<p>${'y'.repeat(5000)}</p>` } }),
      { includeContent: true, maxContentChars: 2000 },
      budget
    );
    expect(String(first.content)).toHaveLength(401);
    expect(second.content).toBeUndefined();
    expect(second.contentOmitted).toBe('budget');
  });

  it('adds the untrusted-data note as soon as any article text is returned', () => {
    const notes = new Notes();
    shapeEntry(
      rawEntry() as RawEntry,
      itemIdToDecimal,
      options,
      { left: 60_000 },
      notes
    );
    expect(notes.list().join(' ')).toMatch(/untrusted data/);
  });

  it('lists enclosures', () => {
    const shaped = shape(
      rawEntry({
        enclosure: [{ href: 'https://example.com/a.mp3', type: 'audio/mpeg' }],
      })
    );
    expect(shaped.enclosures).toEqual([
      { url: 'https://example.com/a.mp3', type: 'audio/mpeg' },
    ]);
  });
});

describe('shapeSubscription', () => {
  it('extracts the numeric feed id and the category', () => {
    const unread = unreadCountIndex([{ id: 'feed/12', count: 7 }]);
    expect(
      shapeSubscription(
        {
          id: 'feed/12',
          title: 'Example News',
          url: 'https://news.example.com/rss',
          htmlUrl: 'https://news.example.com',
          categories: [{ id: 'user/-/label/News', label: 'News' }],
          'frss:priority': 'main_stream',
        },
        unread
      )
    ).toEqual({
      feedId: 12,
      title: 'Example News',
      category: 'News',
      feedUrl: 'https://news.example.com/rss',
      siteUrl: 'https://news.example.com',
      priority: 'main_stream',
      unreadCount: 7,
    });
  });
});

describe('Notes', () => {
  it('deduplicates', () => {
    const notes = new Notes();
    notes.add('a');
    notes.add('a');
    notes.add('b');
    expect(notes.list()).toEqual(['a', 'b']);
  });
});
