# Environment variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `FRESHRSS_URL` | yes | — | Root URL of the FreshRSS instance, e.g. `https://rss.example.com` |
| `FRESHRSS_USER` | yes | — | FreshRSS user name |
| `FRESHRSS_API_PASSWORD` | yes | — | The API password from Settings → Profile → API management |
| `FRESHRSS_READ_ONLY` | no | `false` | `true` registers only the eight read tools |
| `FRESHRSS_INSECURE_TLS` | no | `false` | `true` accepts a self-signed certificate, scoped to this connection |

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

A missing credential is deliberately not fatal: the server must be able to complete
the MCP handshake and answer `tools/list` without one, so registries and sandbox
inspectors can introspect it. Every tool call then fails with the setup instructions.
A malformed URL *is* fatal — that one could send the API password to the wrong host.

All diagnostics go to **stderr**, which is where MCP stdio servers must log — stdout
carries the protocol.

## Notes

- Only the exact string `true` enables `FRESHRSS_READ_ONLY` and
  `FRESHRSS_INSECURE_TLS`; anything else, including `1` and `yes`, leaves them off.
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
