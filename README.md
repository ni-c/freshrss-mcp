# freshrss-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server for
[FreshRSS](https://freshrss.org), the self-hosted RSS and Atom feed aggregator.

It speaks the Google Reader compatible API that FreshRSS exposes at
`/api/greader.php`, and it hides that API's quirks behind tool arguments an
assistant can actually use: numeric feed ids, category and label names, ISO
dates and decimal article ids instead of `user/-/state/com.google/…` stream
identifiers and hexadecimal item tags.

## Requirements

- Node.js 22 or newer
- A FreshRSS instance (developed against 1.29) with
  - the API enabled: **Settings → Authentication → "Allow API access"**
  - an **API password** set for the user: **Settings → Profile → API management**.
    This is a separate password from the web login.

## Configuration

| Variable                | Required | Description                                                                                                          |
| ----------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `FRESHRSS_URL`          | yes      | Root URL of the instance, e.g. `https://rss.example.com`. The API path `/api/greader.php` is appended automatically. |
| `FRESHRSS_USER`         | yes      | FreshRSS user name.                                                                                                  |
| `FRESHRSS_API_PASSWORD` | yes      | The **API password** from the profile page, not the web login password.                                              |
| `FRESHRSS_READ_ONLY`    | no       | `true` registers only the read tools.                                                                                |
| `FRESHRSS_INSECURE_TLS` | no       | `true` accepts self-signed certificates for this connection only.                                                    |

The server starts without credentials so its tools stay listable; every call
then fails with these setup instructions.

### Claude Code

```sh
claude mcp add freshrss -- npx -y @ni-c/freshrss-mcp
```

### Claude Desktop

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "npx",
      "args": ["-y", "@ni-c/freshrss-mcp"],
      "env": {
        "FRESHRSS_URL": "https://rss.example.com",
        "FRESHRSS_USER": "alice",
        "FRESHRSS_API_PASSWORD": "…"
      }
    }
  }
}
```

### Codex

```toml
[mcp_servers.freshrss]
command = "npx"
args = ["-y", "@ni-c/freshrss-mcp"]
env = { FRESHRSS_URL = "https://rss.example.com", FRESHRSS_USER = "alice", FRESHRSS_API_PASSWORD = "…" }
```

## Tools

### Reading

| Tool                | Description                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `get_user_info`     | The authenticated account — a quick credential check.                                       |
| `list_feeds`        | Every subscription with its category and unread count.                                      |
| `list_categories`   | Categories (folders of feeds) and user labels (tags on articles).                           |
| `get_unread_counts` | Total and per-feed/category unread counts, sorted.                                          |
| `list_articles`     | Articles of a feed, category, label or built-in stream, with excerpts or bounded full text. |
| `get_articles`      | Full text of specific articles by id.                                                       |
| `list_article_ids`  | Ids only — the cheap way to collect a set for `mark_articles`.                              |
| `export_opml`       | All subscriptions as an OPML document.                                                      |

### Writing

Not registered when `FRESHRSS_READ_ONLY=true`.

| Tool                       | Description                                           | Confirmation |
| -------------------------- | ----------------------------------------------------- | ------------ |
| `mark_articles`            | Set read state, star and labels on specific articles. | —            |
| `mark_all_as_read`         | Mark a whole feed, category, label or stream as read. | yes          |
| `subscribe_feed`           | Subscribe to a feed or website URL.                   | —            |
| `update_feed`              | Rename a feed or move it to another category.         | —            |
| `unsubscribe_feed`         | Delete a feed and all of its stored articles.         | yes          |
| `rename_category_or_label` | Rename a category or a user label.                    | —            |
| `delete_category_or_label` | Delete a category or a user label.                    | yes          |
| `import_opml`              | Subscribe to every feed in an OPML document.          | yes          |

### No search

FreshRSS does not offer full-text search over its API — the Google Reader
endpoints filter by stream, read state and date only. `list_articles` therefore
has no query parameter; narrow the result with `feed_id`/`category` and
`since`/`until` and filter the returned articles yourself.

## Safety

- **Article text is untrusted input.** Everything this server returns from
  FreshRSS was written by a third party on the internet, so responses that carry
  article text, titles or feed names are explicitly marked as data, never as
  instructions.
- **Destructive tools are two-step.** They return a single-use confirmation
  token bound to the exact target; the second call has to carry it. A plain
  boolean could be set on the very first call, or be talked into it by text
  hidden in a feed. The confirmation messages deliberately never quote titles or
  names coming from the API.
- **Response budgets.** FreshRSS returns up to 500 000 characters of HTML per
  article. Article text is converted to plain text, capped per article and
  against a per-response budget, and is opt-in in listings.
- **Credentials** are read once, removed from `process.env` afterwards and never
  written to disk. Requests never follow redirects, which would resend the
  authorization header to another host, and relaxed TLS validation is scoped to
  this connection instead of the whole process.
- `FRESHRSS_READ_ONLY=true` does not register the write tools at all rather than
  refusing them at call time.

## Development

```sh
npm install
npm run lint && npm run build && npm test
npm run test:coverage
```

## License

MIT
