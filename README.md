# freshrss-mcp

[![CI](https://img.shields.io/github/actions/workflow/status/ni-c/freshrss-mcp/ci.yml?branch=main&label=CI)](https://github.com/ni-c/freshrss-mcp/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/%40ni-c%2Ffreshrss-mcp)](https://www.npmjs.com/package/@ni-c/freshrss-mcp)
[![npm downloads](https://img.shields.io/npm/dm/%40ni-c%2Ffreshrss-mcp)](https://www.npmjs.com/package/@ni-c/freshrss-mcp)
[![node](https://img.shields.io/node/v/%40ni-c%2Ffreshrss-mcp)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/%40ni-c%2Ffreshrss-mcp)](LICENSE)
[![container](https://img.shields.io/badge/ghcr.io-ni--c%2Ffreshrss--mcp-blue)](https://github.com/ni-c/freshrss-mcp/pkgs/container/freshrss-mcp)
[![docs](https://img.shields.io/badge/docs-freshrss--mcp.ni--c.de-informational)](https://freshrss-mcp.ni-c.de)
[![sponsor](https://img.shields.io/badge/sponsor-ni--c-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/ni-c)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server for
[FreshRSS](https://freshrss.org), the self-hosted RSS and Atom feed aggregator.

Lets MCP clients like Claude Code, Claude Desktop or Codex work through your feeds:
see what is unread, read the articles, mark them, and manage subscriptions and
categories.

Sixteen tools is the ceiling, not the floor: `FRESHRSS_ALLOW_TOOLS=essential`
registers a curated seven instead, and a model picks the right tool far more
reliably from seven than from sixteen — see
[choosing which tools load](#choosing-which-tools-load).

It speaks the Google Reader compatible API that FreshRSS exposes at
`/api/greader.php`, and hides that API's quirks behind tool arguments an assistant can
actually use: numeric feed ids, category and label names, ISO dates and decimal
article ids instead of `user/-/state/com.google/…` stream identifiers and hexadecimal
item tags.

<!-- <picture> is resolved against the colour scheme of the page showing it, so GitHub
     picks the variant that matches its own theme toggle. npm strips <picture> and
     <source> when it sanitises the README and keeps the <img>, which is why that
     fallback brings its own dark card instead of relying on a media query. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://freshrss-mcp.ni-c.de/architecture-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="https://freshrss-mcp.ni-c.de/architecture-light.svg">
  <img src="https://freshrss-mcp.ni-c.de/architecture.svg" alt="An MCP client speaks stdio to freshrss-mcp, which calls the Google Reader compatible API of FreshRSS over HTTPS with a GoogleLogin auth token" width="800">
</picture>

<!-- Recorded with vhs from docs/demo.tape against a throwaway FreshRSS 1.29.1. -->

![Demo: listing the tools, the subscribed feeds and the newest article through the MCP Inspector CLI](https://freshrss-mcp.ni-c.de/demo.gif)

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
| `FRESHRSS_READ_ONLY`    | no       | `1`, `true` or `yes` registers only the read tools.                                                                  |
| `FRESHRSS_INSECURE_TLS` | no       | `true` accepts self-signed certificates for this connection only.                                                    |
| `FRESHRSS_ALLOW_TOOLS`  | no       | Comma-separated tool names, `list_*` prefixes, or `essential` for a curated preset                                   |
| `FRESHRSS_DENY_TOOLS`   | no       | Same syntax; removed from whatever `FRESHRSS_ALLOW_TOOLS` left                                                       |
| `ELICITATION`           | no       | `false` replaces the approval dialog with the two-call token. **Not prefixed.**                                      |

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
- **A person is asked, not just told.** Where the client supports MCP
  elicitation, the five irreversible tools raise a real dialog that the model
  cannot answer on its behalf. A plain boolean could be set on the very first
  call, or be talked into it by text hidden in a feed. Where the client cannot
  show a dialog they fall back to a single-use token bound to the exact target,
  and say so rather than implying somebody approved. The messages deliberately
  never quote titles or names coming from the API. See
  [Asking a person](https://freshrss-mcp.ni-c.de/guide/approval).
- **Response budgets.** FreshRSS returns up to 500 000 characters of HTML per
  article. Article text is converted to plain text, capped per article and
  against a per-response budget, and is opt-in in listings. The budget is
  charged for the markup that was read rather than for the text that came out,
  so it bounds the conversion work and not only the resulting context — markup
  that strips away to nothing is the expensive case, and it used to be free.
  The conversion itself is a single left-to-right scan, linear in the length of
  the article whatever the article contains.
- **Credentials** are read once, removed from `process.env` afterwards and never
  written to disk. Requests never follow redirects, which would resend the
  authorization header to another host, and relaxed TLS validation is scoped to
  this connection instead of the whole process.
- **Feed URLs are redacted.** FreshRSS stores HTTP-auth feeds as
  `https://user:password@host/feed`. The userinfo part is stripped before a feed
  URL reaches a tool result or the OPML export, so `list_feeds` cannot print the
  password of a paid or private feed into the transcript.
- **`subscribe_feed` and `import_opml` refuse internal targets.** FreshRSS
  fetches those URLs server-side, which makes both tools an SSRF primitive
  reachable from text inside an article. Loopback and link-local addresses —
  including cloud metadata endpoints — are rejected, for the feed URL and for
  every `xmlUrl`/`htmlUrl` in an OPML document. Addresses are compared
  numerically, so an IPv4-mapped IPv6 literal such as `[::ffff:169.254.169.254]`
  is caught too, and a hostname is resolved before it is accepted. An OPML
  document is read the way an XML parser reads it, and what reaches FreshRSS is
  the document as checked — so the URL that was inspected is the URL that gets
  fetched. Private LAN addresses stay allowed, because self-hosted setups
  legitimately subscribe to feeds on their own network.
- **`import_opml` refuses a `<!DOCTYPE>`.** No XML is parsed in this process, but
  the document is handed to FreshRSS, where a document type declaration is the
  carrier for entity-expansion and external-entity attacks. OPML never needs one.
- `FRESHRSS_READ_ONLY=true` does not register the write tools at all rather than
  refusing them at call time.

Which tools ask a person: `mark_all_as_read`, `unsubscribe_feed`,
`delete_category_or_label`, `import_opml` — and `mark_articles`, but only when it
is about to mark something **read**. Starring, unstarring and labelling can all
be set back; which of those articles were unread cannot, and FreshRSS keeps no
record of it.

## Container

```sh
docker run --rm -i \
  -e FRESHRSS_URL=https://rss.example.com \
  -e FRESHRSS_USER=alice \
  -e FRESHRSS_API_PASSWORD=... \
  ghcr.io/ni-c/freshrss-mcp:latest
```

The image is published for `linux/amd64` and `linux/arm64` with an SBOM and build
provenance. It runs as the unprivileged `node` user and carries no npm, so the
only thing in it is Node, the runtime dependencies and `dist/`.

## Development

```sh
npm install
npm run lint && npm run build && npm test
npm run test:coverage
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for a throwaway FreshRSS to develop
against. The full documentation lives at
[freshrss-mcp.ni-c.de](https://freshrss-mcp.ni-c.de).

## Releasing

1. Move the `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md) under the new
   version and bump `version` in `package.json`.
2. `npm run lint && npm run build && npm run test:coverage`.
3. Commit, then tag: `git tag -s vX.Y.Z -m vX.Y.Z && git push origin main vX.Y.Z`.

The tag triggers `release.yml`, which verifies the tag matches `package.json`,
publishes to npm via [Trusted Publishing](https://docs.npmjs.com/trusted-publishers)
with provenance (no token involved), creates the GitHub release from the CHANGELOG
section, and publishes the entry to the
[MCP Registry](https://registry.modelcontextprotocol.io). If only the registry
step fails, fix it on `main` and re-run `mcp-registry.yml` by hand — never re-run
the tagged job, which would check out the old tree.

## License

MIT

### Choosing which tools load

`FRESHRSS_ALLOW_TOOLS` and `FRESHRSS_DENY_TOOLS` take comma-separated tool names;
a trailing `*` matches a whole family. `essential` is a curated preset of
seven: `list_feeds`, `list_categories`, `get_unread_counts`, `list_articles`, `get_articles`, `mark_articles`, `mark_all_as_read`.

```sh
FRESHRSS_ALLOW_TOOLS=essential
FRESHRSS_ALLOW_TOOLS=list_feeds,list_articles,mark_articles
FRESHRSS_DENY_TOOLS=delete_*
```

An entry that matches no tool aborts startup and names it, so a typo cannot
silently hide a tool — an absent tool is not something anyone traces back to an
environment variable. A filtered tool is never registered, so it is absent from
`tools/list` and unknown to `tools/call` alike, exactly like a write tool under
`FRESHRSS_READ_ONLY`.

If you run several of these servers at once, [mcp-hub](https://mcp-hub.ni-c.de)
is the other answer — its `/hub` endpoint replaces every server's tools with six
meta-tools.
