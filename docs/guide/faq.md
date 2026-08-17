# FAQ & troubleshooting

## FreshRSS rejects the login (401)

You are almost certainly using the web login password. The API password is a separate
value under **Settings → Profile → API management**. It also becomes invalid when
changed, and the server caches the auth token — but it retries the login exactly once
after a 401, so a rotated password recovers on the next call rather than needing a
restart.

## "FreshRSS reports the API as disabled" (503)

**Settings → Authentication →** tick **"Allow API access"**. This is separate from
setting an API password; both are required.

## The response is not JSON / a 404 with a base-URL hint

`FRESHRSS_URL` is not the instance root. Give it `https://rss.example.com`, not
`https://rss.example.com/api/greader.php` — the API path is appended automatically. A
reverse proxy serving an interstitial or login page produces the same symptom.

## A category returns no articles, but I know it has some

FreshRSS matches category and label names **literally, including case**, and a name
that does not exist returns an *empty list* rather than an error — verified against
1.29.1. So `category: "news"` when the category is called `News` looks exactly like
"nothing unread". The listing tools add a `hint` field in that situation; call
`list_categories` and copy the name exactly.

The same holds for a `feed_id` that does not exist. Only a malformed built-in stream
id produces HTTP 400.

Note also that categories and user labels share one namespace in this API: FreshRSS
looks for a category first and falls back to a label, so a category and a label with
the same name cannot be told apart.

## Why can I not search my articles?

FreshRSS offers no full-text search over the Google Reader API — the endpoints filter
by stream, read state and date only. Narrow with `feed_id`, `category`, `since` and
`until`, then filter the returned articles yourself. Full-text search exists in the
FreshRSS web interface, but there is no API endpoint behind it.

## Article text is truncated

By design. Listings return a short excerpt; pass `include_content: true` for full
text, and raise `max_content_chars` (up to 20 000) if you need more. There is also a
per-response budget of 60 000 characters, so a listing of 100 articles cannot bury
everything else. When it runs out, the response says so and names `get_articles` as
the way to fetch the rest.

## Marking articles as read did nothing

Check that you passed the ids from `list_articles` or `list_article_ids` unchanged.
FreshRSS reports ids as hexadecimal item tags but matches writes on the decimal row
id; both forms are accepted here and converted, but a hand-edited or number-parsed id
will silently address a different article — which is why ids go through `BigInt`.

## Self-signed certificate

`FRESHRSS_INSECURE_TLS=true`. It is scoped to the connection to your instance, not
process-wide, and is announced on stderr at startup. Prefer a real certificate.

## Can I stop it from writing anything?

`FRESHRSS_READ_ONLY=true`. The eight write tools are then not registered at all, so
they do not appear in `tools/list`.

## Which FreshRSS versions work?

Developed and verified against 1.29. The Google Reader endpoints it uses have been
stable for years, so older releases most likely work; the `frss:priority` field and
the `org.freshrss/main` and `org.freshrss/important` states are FreshRSS extensions
and will simply be absent elsewhere.

## Something is still wrong

Run it under the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
to see raw requests and responses:

```sh
npx @modelcontextprotocol/inspector npx -y @ni-c/freshrss-mcp
```

Then open an [issue](https://github.com/ni-c/freshrss-mcp/issues) — with the FreshRSS
version and the tool call, and **without** real credentials, tokens or hostnames.
