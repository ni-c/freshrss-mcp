# Tools

All sixteen are registered unless you say otherwise. `FRESHRSS_ALLOW_TOOLS` and
`FRESHRSS_DENY_TOOLS` narrow the list to the ones you want, and `essential` selects a
curated seven — see
[choosing the tools that load](/guide/configuration#choosing-the-tools-that-load).

Sixteen tools: eight read, eight write. With `FRESHRSS_READ_ONLY=true` only the read
tools are registered.

Tools marked **two-step** return a single-use confirmation token on the first call and
perform the operation only when called again with that token — see
[Security](/guide/security#confirmation-tokens).

## Stream selectors

Six tools address "where to read from" with the same four mutually exclusive
parameters. Set exactly one; the default is the whole reading list.

| Parameter | Type | Meaning |
| --- | --- | --- |
| `feed_id` | integer | Numeric `feedId` from `list_feeds` |
| `category` | string | Category (folder) name, exactly as in `list_categories` |
| `label` | string | User label name, exactly as in `list_categories` |
| `stream` | enum | `reading-list` (default), `starred`, `main`, `important` |

`main` and `important` are FreshRSS extensions: feeds shown on the main stream, and
feeds marked as important.

::: warning A wrong name looks like "nothing new"
Names are matched literally, including case — copy them from `list_categories`. A
category, label or feed id that does **not exist** returns an empty list rather than
an error (verified against FreshRSS 1.29.1); only a malformed built-in stream id
produces HTTP 400. The listing tools add a `hint` field when they return nothing for
one of these selectors, precisely so a typo is not reported as an empty inbox.

Categories and user labels also share one namespace in this API, so `category` and
`label` resolve identically — the two parameters exist only so tool descriptions can
stay readable.
:::

## Read tools

### get_user_info

No parameters. Returns `userId`, `userName` and `userEmail`. The cheapest way to check
that the credentials work.

### list_feeds

No parameters. Every subscribed feed with `feedId`, `title`, `category`, `feedUrl`,
`siteUrl`, `priority` and `unreadCount`, plus `feedCount` and `totalUnread`.

Feed URLs have any embedded credentials redacted. If `/unread-count` is unavailable the
feed list is still returned, with a note and no `unreadCount`.

### list_categories

No parameters. Returns `categories` and `labels` separately — FreshRSS distinguishes
them by the tag type even though they share a namespace — each with an `unreadCount`,
plus the names of the built-in streams.

### get_unread_counts

No parameters. Unread totals per feed and per category, sorted by count, with
`totalUnread`. Only entries that actually have unread articles are listed.

### list_articles

Stream selector, plus:

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `filter` | enum | `unread` | `unread`, `read`, `starred`, `all` |
| `limit` | 1–100 | 20 | Maximum articles |
| `order` | enum | `newest` | `newest` or `oldest` by publication date |
| `since` | ISO date | — | Only articles published after this |
| `until` | ISO date | — | Only articles published before this |
| `continuation` | string | — | Value from a previous call, for the next page |
| `include_content` | boolean | `false` | Full article text instead of an excerpt |
| `max_content_chars` | 100–20000 | 2000 | Characters of text per article |

Each article carries `id`, `title`, `author`, `published`, `url`, `feed`, `read`,
`starred`, `priority`, `labels`, any `enclosures`, and either `excerpt` (300 characters)
or `content`. `since`/`until` also accept a bare unix timestamp.

**There is no keyword search** — FreshRSS does not offer one over this API. Narrow with
the selector and the date range, then filter what comes back.

### get_articles

| Parameter | Type | Default | Meaning |
| --- | --- | --- | --- |
| `article_ids` | string[] (1–20) | — | Ids from `list_articles` |
| `max_content_chars` | 100–20000 | 2000 | Characters of text per article |

Full text for specific articles. Ids that returned nothing are reported as a count —
FreshRSS retention settings may have purged them.

### list_article_ids

Same parameters as `list_articles` minus the content options. Returns just
`articleIds`, `count` and `continuation` — the cheap way to collect a set for
`mark_articles`.

### export_opml

No parameters. All subscriptions as an OPML document, the portable backup format.
Credentials in `xmlUrl` attributes are redacted; the document is truncated at 200 000
characters. For a readable overview use `list_feeds`.

## Write tools

### mark_articles

| Parameter | Type | Meaning |
| --- | --- | --- |
| `article_ids` | string[] (1–100) | Ids from `list_articles` |
| `read` | boolean | `true` marks read, `false` unread |
| `starred` | boolean | `true` adds the star, `false` removes it |
| `add_labels` | string[] | Labels to attach; unknown ones are created |
| `remove_labels` | string[] | Labels to detach |

At least one change is required; each is applied to every given article. Not
confirmation-gated — see [why](/guide/security#confirmation-tokens).

### mark_all_as_read — two-step

Stream selector, plus `older_than` (ISO date, default: all) and `confirm_token`.

Marks an entire feed, category, label or stream as read. Which articles were unread
before cannot be recovered, which is why it is gated.

### subscribe_feed

| Parameter | Type | Meaning |
| --- | --- | --- |
| `url` | string | Feed URL or website URL (http/https) |
| `title` | string | Title to use instead of the feed's own |
| `category` | string | Category to file it under; created if unknown |

FreshRSS discovers the feed from a website URL and then downloads it, so this can take
a while — the timeout is 120 s. Loopback and link-local URLs are refused: FreshRSS
fetches the URL itself, which would make this an
[SSRF primitive](/guide/security#subscribe-feed-and-import-opml-are-server-side-fetches).

### update_feed

`feed_id` (integer, required), plus `title` and/or `category`. At least one of the two.
Fields not given stay unchanged; an unknown category is created.

### unsubscribe_feed — two-step

`feed_id` (integer) and `confirm_token`.

Deletes the feed **and all of its stored articles, read state and stars**. Not
reversible: re-subscribing starts from whatever the feed currently offers.

### rename_category_or_label

`name` and `new_name`. FreshRSS resolves the name against categories first and falls
back to labels, so one tool covers both. Feeds and articles keep their assignment.

### delete_category_or_label — two-step

`name` and `confirm_token`.

For a **category**, its feeds move to the default category and no articles are lost.
For a **label**, it is detached from every article. Because FreshRSS matches categories
first, a category and a label of the same name cannot be told apart here.

### import_opml — two-step

`opml` (the document, up to 900 000 characters) and `confirm_token`.

Subscribes to every feed in the document, creates the categories it names, then
refreshes everything — minutes, on a large file. There is no bulk undo. Documents with
a `<!DOCTYPE>` or `<!ENTITY>` declaration are
[refused](/guide/security#import-opml-refuses-a-doctype), and so are documents whose
`xmlUrl` or `htmlUrl` points at a loopback or link-local address, or at a scheme other
than http/https — FreshRSS fetches each of them
[server-side](/guide/security#subscribe-feed-and-import-opml-are-server-side-fetches).
A document that does not read as well-formed XML is refused rather than guessed at.
What reaches FreshRSS is the document as checked: its encoding declaration rewritten to
UTF-8 and each feed URL written back in its parsed form. The confirmation prompt names
the hosts the document would subscribe to.

The token is bound to a fingerprint of the exact document, so confirming one OPML
cannot authorise importing another.
