import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { redactOpmlCredentials, redactUrlCredentials } from '../src/redact.js';
import {
  feedIdFromStreamId,
  htmlToText,
  labelFromStreamId,
} from '../src/shape.js';

/**
 * Properties of the redaction and text layers.
 *
 * Both carry a bug in their history that a property would have caught first.
 * The redaction class deliberately does not exclude `@`, because FreshRSS does
 * not percent-encode the password it stores and stopping at the first `@` would
 * publish the tail of it. And `htmlToText` strips markup twice around a single
 * entity decode, because decoding after the tag pass rebuilt `&lt;script&gt;`
 * into markup that nothing looked at again.
 *
 * Neither of those is visible in an example unless somebody thinks to write the
 * example. A generator writes them constantly.
 */

const RUNS = { numRuns: 500 };

describe('credential redaction', () => {
  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (value) => {
        const once = redactUrlCredentials(value);
        expect(redactUrlCredentials(once)).toBe(once);
      }),
      RUNS
    );
  });

  it('leaves a URL without credentials byte-identical', () => {
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        fc.pre(!url.includes('@'));
        expect(redactUrlCredentials(url)).toBe(url);
      }),
      RUNS
    );
  });

  /**
   * The property the class was widened for. FreshRSS stores an HTTP-auth feed
   * as `https://user:pass@host/feed` and returns it verbatim from
   * `subscription/list`, so a password containing `@` is an ordinary stored
   * feed rather than an edge case — and stopping at the first one published the
   * rest of it into the model context.
   */
  it('publishes no fragment of a password, wherever its @ falls', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z]{3,12}$/),
        fc.stringMatching(/^[A-Za-z0-9]{3,10}$/),
        fc.stringMatching(/^[A-Za-z0-9]{3,10}$/),
        fc.stringMatching(/^[a-z]{3,12}(\.[a-z]{2,6})+$/),
        (user, head, tail, host) => {
          fc.pre(!host.includes(head) && !host.includes(tail));
          const redacted = redactUrlCredentials(
            `https://${user}:${head}@${tail}@${host}/feed`
          );
          expect(redacted).toBe(`https://***@${host}/feed`);
          expect(redacted).not.toContain(head);
          expect(redacted).not.toContain(tail);
        }
      ),
      RUNS
    );
  });

  /**
   * The OPML export carries the same URLs in attributes, and it is the one
   * place a whole subscription list leaves at once — so a miss there is every
   * password rather than one.
   */
  it('redacts every credential-bearing attribute of an OPML document', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            user: fc.stringMatching(/^[a-z]{3,8}$/),
            // Ends in a digit, and a host has none: the property reads "the
            // password is not in the output", and a password of lower-case
            // letters can be a substring of the host that legitimately stays
            // (`totype` in `totypea.aa`, seed 2132840900 on 2026-09-07).
            password: fc.stringMatching(/^[A-Za-z0-9]{5,13}[0-9]$/),
            host: fc.stringMatching(/^[a-z]{3,10}\.[a-z]{2,4}$/),
          }),
          { minLength: 1, maxLength: 6 }
        ),
        (feeds) => {
          const opml = feeds
            .map(
              ({ user, password, host }) =>
                `<outline xmlUrl="https://${user}:${password}@${host}/rss" htmlUrl="https://${user}:${password}@${host}/" />`
            )
            .join('\n');
          const redacted = redactOpmlCredentials(opml);
          for (const { password } of feeds) {
            expect(redacted).not.toContain(password);
          }
          expect(redacted.split('***@').length - 1).toBe(feeds.length * 2);
        }
      ),
      {
        ...RUNS,
        // The counterexample the old generator produced: a password that is a
        // prefix of the host. It passes now because the redaction is right
        // and the password can no longer be spelled out of a host.
        examples: [
          [
            [
              { user: 'aaa', password: 'totype1', host: 'totypea.aa' },
              { user: 'aaa', password: 'aaAaaa1', host: 'aaa.aa' },
            ],
          ],
        ],
      }
    );
  });
});

describe('stream ids decode to what they name', () => {
  it('a feed id round trips', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 ** 9 }), (id) => {
        expect(feedIdFromStreamId(`feed/${id}`)).toBe(id);
      }),
      RUNS
    );
  });

  it('a label round trips, whatever the name holds', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (name) => {
        expect(labelFromStreamId(`user/-/label/${name}`)).toBe(name);
      }),
      RUNS
    );
  });

  /**
   * Anything that is not the shape it claims returns null rather than a number.
   * A wrong feed id is worse than none: it addresses a different feed, and
   * nothing downstream would notice.
   */
  it('a stream id of another shape is refused', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (id) => {
        const parsed = feedIdFromStreamId(id);
        if (parsed === null) return;
        expect(Number.isInteger(parsed)).toBe(true);
        expect(id.startsWith('feed/')).toBe(true);
        expect(String(parsed)).toBe(id.slice('feed/'.length).trim());
      }),
      RUNS
    );
  });

  it('undefined is null, not a crash', () => {
    expect(feedIdFromStreamId(undefined)).toBeNull();
    expect(labelFromStreamId(undefined)).toBeNull();
  });
});

describe('markup never survives into the text', () => {
  /**
   * The fixpoint strip, stated as the property it exists for: a single pass
   * lets overlapping constructs reassemble, and the output is text an MCP
   * client may render as markdown.
   */
  it('no element survives, however the fragments are spliced', () => {
    const fragment = fc.oneof(
      fc.constantFrom(
        '<script>',
        '</script>',
        '<<script>script>',
        '<scr<script>ipt>',
        '<img src=x onerror=y>',
        '<style>',
        '<div>',
        '<!-- -->',
        '<'
      ),
      fc.string({ maxLength: 12 })
    );
    fc.assert(
      fc.property(fc.array(fragment, { maxLength: 30 }), (parts) => {
        const { text } = htmlToText(parts.join(''), 1000);
        // A `<` that starts no element name is text and stays: `stripMarkup`
        // keeps it on purpose, because "if x < y" is a comparison and feeds
        // are full of them. So can an unterminated `</script`, assembled from
        // a kept `<` and later text — inert in HTML and in markdown alike,
        // since nothing closes it. What must never survive is a *complete*
        // element, which is the only form a renderer would act on.
        expect(text).not.toMatch(/<\/?[a-zA-Z][^<>]*>/);
      }),
      RUNS
    );
  });

  /**
   * The bug this file already fixed: entities decode to angle brackets, and
   * that happened once the tag pass was over. Stripping runs again afterwards,
   * and exactly once more — so doubly encoded text stays the text it is.
   */
  it('entities cannot rebuild a tag after stripping', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.constantFrom(
            '&lt;',
            '&gt;',
            '&#60;',
            '&#x3c;',
            '&#62;',
            '&amp;lt;',
            'script',
            '/script',
            '&amp;'
          ),
          { maxLength: 30 }
        ),
        (parts) => {
          const { text } = htmlToText(parts.join(''), 1000);
          expect(text).not.toMatch(/<\/?[a-zA-Z][^<>]*>/);
        }
      ),
      RUNS
    );
  });

  /**
   * The exact shape the property found, kept as a named regression.
   *
   * The kept `<` survives as the text it is, separated from what followed the
   * dropped `<>` — `< img …>` is a comparison sign and some words to a
   * browser, to a markdown renderer and to a model alike. What it must never
   * be is `<img …>`.
   */
  it('cannot be made to emit a live element by encoding it', () => {
    const LIVE = /<\/?[a-zA-Z][^<>]*>/;
    const img = htmlToText('&lt;&lt;&gt;img src=x onerror=alert(1)&gt;', 1000);
    expect(img.text).toBe('< img src=x onerror=alert(1)>');
    expect(img.text).not.toMatch(LIVE);
    expect(htmlToText('&lt;&lt;&gt;script&gt;', 1000).text).not.toMatch(LIVE);
    expect(htmlToText('&lt;&lt;&gt;/script&gt;', 1000).text).not.toMatch(LIVE);
  });

  it('doubly encoded text stays literal rather than being decoded twice', () => {
    expect(htmlToText('&amp;lt;script&amp;gt;', 1000).text).toBe(
      '&lt;script&gt;'
    );
  });

  it('respects its character limit, plus the truncation marker', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 5000 }),
        fc.integer({ min: 1, max: 400 }),
        (html, limit) => {
          const { text, truncated } = htmlToText(html, limit);
          expect(text.length).toBeLessThanOrEqual(limit + 1);
          if (text.length > limit) expect(truncated).toBe(true);
        }
      ),
      RUNS
    );
  });
});
