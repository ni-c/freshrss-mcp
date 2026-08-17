# What is freshrss-mcp?

[FreshRSS](https://freshrss.org) is a self-hosted RSS and Atom aggregator. It
exposes a Google Reader compatible API at `/api/greader.php`, which is how mobile
readers like Reeder and FeedMe talk to it.

`freshrss-mcp` puts that API behind the [Model Context
Protocol](https://modelcontextprotocol.io), so an assistant can answer "what is
new in my feeds?", summarise the morning's articles, clean up subscriptions, or
mark a backlog as read.

## Why not talk to the API directly?

Because the Google Reader API is a museum piece. It was reverse-engineered from a
product Google shut down in 2013, and its vocabulary leaks through everywhere:

| The API wants | These tools take |
| --- | --- |
| `user/-/state/com.google/reading-list` | `stream: "reading-list"` |
| `user/-/label/News` | `category: "News"` |
| `feed/12` | `feed_id: 12` |
| `tag:google.com,2005:reader/item/0006218f8a2b1c40` | `"1719238946946112"` |
| `ot=1755388800` (unix seconds) | `since: "2026-08-17"` |
| `ts` in microseconds, documented as nanoseconds | an ISO date |
| up to 500 000 characters of raw HTML per article | plain text, capped |

The article id case is the one that bites hardest: the API reports ids as
hexadecimal item tags but its write endpoints match on the decimal row id, and the
values exceed 2^53 — so parsing them as JavaScript numbers silently edits a
*different* article. This server converts them through `BigInt`.

## What it does not do

**There is no search.** FreshRSS offers no full-text search over this API; the
Google Reader endpoints filter by stream, read state and date only. `list_articles`
therefore has no query parameter. Narrow with `feed_id`, `category`, `since` and
`until`, then filter the returned articles yourself.

## Next

- [Getting started](/guide/getting-started) — enable the API and set an API password
- [Connecting clients](/guide/clients) — Claude Code, Claude Desktop, Codex, Docker
- [Security](/guide/security) — what the credentials grant and how feeds are treated
