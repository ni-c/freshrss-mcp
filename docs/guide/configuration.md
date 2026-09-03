# Configuration

Everything is configured through environment variables. There is no config file, and
nothing is written to disk.

| Variable | Required | Description |
| --- | --- | --- |
| `FRESHRSS_URL` | yes | Root URL of the instance, e.g. `https://rss.example.com`. The API path `/api/greader.php` is appended automatically. |
| `FRESHRSS_USER` | yes | FreshRSS user name. |
| `FRESHRSS_API_PASSWORD` | yes | The **API password** from Settings → Profile → API management, not the web login password. |
| `FRESHRSS_READ_ONLY` | no | `1`, `true` or `yes` registers only the read tools. |
| `FRESHRSS_INSECURE_TLS` | no | `true` accepts a self-signed certificate for this connection only. |
| `ELICITATION` | no | `false` replaces the approval dialog with the two-call token. **Not prefixed.** |

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

With `1`, `true` or `yes` — any casing, surrounding whitespace ignored — the write
tools are **not registered at all**: they do not appear in `tools/list`. This is
deliberate: a tool that exists but refuses at call time still invites the model to
try, and still shows up in the client's tool picker.

It is read that tolerantly on purpose, and `FRESHRSS_INSECURE_TLS` below is not.
This switch turns a protection **on**, so a value the operator meant as yes but
spelled as `1` has to be taken as yes — being strict here means handing somebody
who asked for the guard a server with every write tool, and no way to notice. The
other switch turns a protection **off**, where being strict is what keeps a typo
harmless.

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

## Choosing the tools that load

Read-only mode is one cut, along a line this server drew for you.
`FRESHRSS_ALLOW_TOOLS` and `FRESHRSS_DENY_TOOLS` let you draw your own:

```sh
FRESHRSS_ALLOW_TOOLS=essential
FRESHRSS_ALLOW_TOOLS=list_feeds,list_articles,mark_articles
FRESHRSS_DENY_TOOLS=delete_*
```

Why bother, when all sixteen work: a model chooses the right tool far more
reliably from a handful than from a long list, and every tool it can see costs
context on every single request. If this is the only MCP server in a session,
sixteen is fine. If it is one of six, it is not.

**The syntax.** Comma-separated entries. An entry is either an exact tool name or
a prefix with a trailing `*` — `list_*` matches every tool whose name starts with
`list_`. Entries are trimmed and case-insensitive, empty ones are ignored, and an
empty value counts as unset. Nothing else is a pattern: `*_x` and `list_*_x` are
rejected rather than silently matching nothing.

**`essential`** is a curated preset of seven:

`list_feeds`, `list_categories`, `get_unread_counts`, `list_articles`, `get_articles`, `mark_articles`, `mark_all_as_read`.

It composes — naming a tool alongside it puts that one back, and
`FRESHRSS_DENY_TOOLS` takes one away.

**Both together.** `FRESHRSS_ALLOW_TOOLS` decides what is in;
`FRESHRSS_DENY_TOOLS` is then subtracted from the result. With only a deny list,
everything else stays.

**A name that matches nothing stops the server**, with the offending entry and the
list of real names. That is deliberate: the alternative is a tool quietly missing
from `tools/list`, and nobody traces an absence back to an environment variable.
The same applies to a pattern that matches no tool.

**With read-only mode**, the write tools are not registered at all, so naming
one explicitly in `FRESHRSS_ALLOW_TOOLS` is an error that says so — rather than
calling a tool unknown when it plainly exists. A _pattern_ that covers write
tools is fine and simply contributes nothing, and
`FRESHRSS_ALLOW_TOOLS=essential` narrows to the read half of the preset.

::: tip It is the same cut, not a second one
A filtered tool is never registered, so it is absent from `tools/list` and
unknown to `tools/call` alike — exactly what `FRESHRSS_READ_ONLY` does to a
write tool. There is no "hidden but callable" state to reason about.
:::
