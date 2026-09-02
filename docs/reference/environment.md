# Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FRESHRSS_URL` | yes | — | Root URL of the FreshRSS instance, e.g. `https://rss.example.com` |
| `FRESHRSS_USER` | yes | — | FreshRSS user name |
| `FRESHRSS_API_PASSWORD` | yes | — | The API password from Settings → Profile → API management |
| `FRESHRSS_READ_ONLY` | no | `false` | `1`, `true` or `yes` registers only the eight read tools |
| `FRESHRSS_INSECURE_TLS` | no | `false` | `true` accepts a self-signed certificate, scoped to this connection |
| `ELICITATION` | no | `true` | `false` replaces the approval dialog with the two-call token. **Not prefixed** |

There is no configuration file and no command-line flag; these are the whole surface.
The reasoning behind each is in [Configuration](/guide/configuration).

## Validation at startup

| Condition | Result |
| --- | --- |
| A required variable is missing | Warning; the server starts and lists tools |
| `FRESHRSS_URL` does not parse | **Exit 1** (the value is logged with credentials redacted) |
| `FRESHRSS_URL` scheme is not `http`/`https` | **Exit 1** |
| `FRESHRSS_URL` contains `user:password@` | **Exit 1** |
| `FRESHRSS_URL` is plain http to a non-loopback host | Warning about the unencrypted API password |
| `FRESHRSS_INSECURE_TLS=true` | Warning that certificate validation is relaxed |
| `ELICITATION` is neither `true` nor `false` | **Exit 1**, naming both valid values |
| `ELICITATION=false` | One line saying guarded tools fall back to the two-call token |

A missing credential is deliberately not fatal: the server must be able to complete
the MCP handshake and answer `tools/list` without one, so registries and sandbox
inspectors can introspect it. Every tool call then fails with the setup instructions.
A malformed URL *is* fatal — that one could send the API password to the wrong host.

All diagnostics go to **stderr**, which is where MCP stdio servers must log — stdout
carries the protocol.

## `ELICITATION`

**Optional**, default `true`. Whether a client that *can* show a dialog is asked
before a guarded tool acts. `false` takes the two-call-token path instead — it does
not remove the guard, and a server started with it off prints one line saying so.

Two ways it differs from every other variable on this page:

- **No prefix.** One `export ELICITATION=false` reaches every MCP server in the same
  environment, not just this one. That is the point of it and also its risk; see
  [Asking a person](/guide/approval).
- **Fatal on anything else.** `1`, `off` or a typo stop the server with exit code 1
  rather than falling back to the default. It is the only variable of this family
  that defaults to *on*, and a typo that fell back would leave the dialog running
  while you believed it was off.

Values are trimmed and matched case-insensitively, so `False` and ` false ` both
work — the strictness is about which words count, not about their shape. It is read
*after* `FRESHRSS_API_PASSWORD` is deleted from `process.env`, so the fatal path
cannot leave the password sitting there for a crash reporter.

## Notes

- `FRESHRSS_READ_ONLY` accepts `1`, `true` or `yes`, in any casing and with
  surrounding whitespace ignored. Anything else leaves it off. It is read
  tolerantly because it turns a protection **on**: a value the operator meant as
  yes but spelled differently would otherwise register every write tool and say
  nothing about it.
- `FRESHRSS_INSECURE_TLS` needs the exact string `true`; `1` and `yes` leave it
  off. Read strictly for the mirror-image reason — it turns a protection **off**,
  so a value nobody spelled exactly has to leave certificate validation on.
- Trailing slashes on `FRESHRSS_URL` are stripped.
- The API path `/api/greader.php` is appended automatically — do not include it.
- `FRESHRSS_API_PASSWORD` is **deleted from `process.env`** once the configuration has
  been read, on every path including the ones that then exit. It would otherwise stay
  readable by child processes and in `/proc/<pid>/environ`.
- Requests use a 30-second timeout (120 seconds for `subscribe_feed` and
  `import_opml`, which make FreshRSS fetch from the internet first) and refuse to
  follow redirects.

## Limits

Not configurable, but they bound every response:

| Limit | Value |
| --- | --- |
| Articles per listing | 100 (default 20) |
| Ids per `get_articles` | 20 |
| Articles per `mark_articles` | 100 |
| Article text per article | 20 000 characters (default 2000) |
| Excerpt length | 300 characters |
| Article text per response | 60 000 characters |
| Serialised tool result | 400 000 characters |
| OPML export | 200 000 characters |
| OPML import | 900 000 characters |
| Confirmation token lifetime | 5 minutes, single use |

The OPML import limit sits below the 1 048 576 bytes FreshRSS reads from
`php://input` — beyond that it truncates silently, which would arrive as malformed
XML.

## Narrowing the tool list

| Variable | Required | Description |
| --- | --- | --- |
| `FRESHRSS_ALLOW_TOOLS` | no | Tool names, `list_*` prefixes or `essential`; only these register |
| `FRESHRSS_DENY_TOOLS` | no | Same syntax; subtracted from whatever the allow list left |

Both are comma-separated. Each entry is either an exact tool name or a prefix with
a single trailing `*`. Entries are trimmed and matched case-insensitively; empty
entries are ignored, and a value that is empty or only whitespace counts as unset —
`FRESHRSS_ALLOW_TOOLS=` in a compose file does not mean "allow nothing".
`essential` is recognised only in the allow list, and selects `list_feeds`, `list_categories`, `get_unread_counts`, `list_articles`, `get_articles`, `mark_articles`, `mark_all_as_read`.

**An entry that matches no tool aborts startup**, naming the entry and listing the
valid names, as does a malformed pattern such as `*_x` or `list_*_x`. The
alternative — ignoring the entry — leaves a tool missing from `tools/list` with
nothing pointing at the cause. If both lists together remove everything, the server
refuses to start rather than offering an empty tool list.

Under `FRESHRSS_READ_ONLY`, an exact write-tool name in the allow list is an
error naming the read-only setting rather than "unknown tool"; a pattern covering
write tools is accepted and merely contributes nothing, with a warning on stderr.
Deny entries are exempt: denying an already-suppressed tool is how a defensive
list is written.
