# Configuration

Everything is configured through environment variables. There is no config file, and
nothing is written to disk.

| Variable | Required | Description |
| --- | --- | --- |
| `FRESHRSS_URL` | yes | Root URL of the instance, e.g. `https://rss.example.com`. The API path `/api/greader.php` is appended automatically. |
| `FRESHRSS_USER` | yes | FreshRSS user name. |
| `FRESHRSS_API_PASSWORD` | yes | The **API password** from Settings → Profile → API management, not the web login password. |
| `FRESHRSS_READ_ONLY` | no | `true` registers only the read tools. |
| `FRESHRSS_INSECURE_TLS` | no | `true` accepts a self-signed certificate for this connection only. |

See the [environment reference](/reference/environment) for the exact validation
rules.

## `FRESHRSS_URL`

Point it at the **root** of the instance — where the web interface lives — not at
the API path. `https://rss.example.com` is right; `https://rss.example.com/api/greader.php`
is not, and produces a 404 with a hint saying so.

The URL is validated at startup and the process exits on a bad value, because a
malformed URL is exactly how credentials get sent to the wrong host:

- Only `http://` and `https://` are accepted.
- Credentials embedded in the URL (`https://user:pass@host`) are rejected — use
  `FRESHRSS_USER` and `FRESHRSS_API_PASSWORD`.
- Trailing slashes are stripped.
- Plain `http://` to a non-loopback host is a warning, not an error: the API
  password would travel unencrypted.

## `FRESHRSS_READ_ONLY`

With `true`, the write tools are **not registered at all** — they do not appear in
`tools/list`. This is deliberate: a tool that exists but refuses at call time still
invites the model to try, and still shows up in the client's tool picker.

Read-only leaves eight tools: `get_user_info`, `list_feeds`, `list_categories`,
`get_unread_counts`, `list_articles`, `get_articles`, `list_article_ids` and
`export_opml`.

## `FRESHRSS_INSECURE_TLS`

For an instance with a self-signed certificate. It is implemented as a scoped
[undici](https://undici.nodejs.org) dispatcher, **not** by setting
`NODE_TLS_REJECT_UNAUTHORIZED` — so it relaxes validation for connections to your
FreshRSS instance and nothing else in the process. The server announces it on stderr
at startup so it cannot be on by accident and forgotten.

A proper certificate is still better. This exists so a homelab instance is usable
today, not as a recommendation.

## Timeouts

Not configurable, but worth knowing:

- **30 s** for normal requests.
- **120 s** for `subscribe_feed` and `import_opml`. Both make FreshRSS fetch from
  the internet before answering — `quickadd` downloads and parses the feed, and
  `subscription/import` subscribes to every entry in the OPML and then refreshes
  all of them.

## Credential handling

`FRESHRSS_API_PASSWORD` is deleted from `process.env` immediately after the config
is read, on every code path — including the ones that then exit. Otherwise it stays
visible to child processes and in `/proc/<pid>/environ` for the process lifetime.

The login uses POST rather than GET so the password does not land in the FreshRSS
access log, and both the auth token and the write token are cached in memory only.
