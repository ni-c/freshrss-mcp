# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/freshrss-mcp.git && cd freshrss-mcp
npm install
npm test          # no instance needed, the FreshRSS API is stubbed
npm run build
```

## Running the integration suite

The unit tests stub the GReader endpoints, which is exactly where the
interesting part is: GReader is a protocol FreshRSS _reimplements_, and the
places where its reimplementation differs from what the documentation implies
are what a stub cannot show. The integration suite spawns the built server over
stdio against a throwaway FreshRSS in Docker and calls **every tool in the
catalogue**.

```sh
npm run build     # the suite runs dist/index.js, not src/
docker compose -f test/integration/compose.yml up -d
npm run test:integration
docker compose -f test/integration/compose.yml down -v
```

`down -v` is not tidiness: the suite subscribes at fixed URLs and unsubscribes
at the end, and FreshRSS refuses a duplicate subscription with "Already
subscribed!".

The compose stack runs FreshRSS's **CLI installer** through
`FRESHRSS_INSTALL` / `FRESHRSS_USER`, because the first request is otherwise a
five-step browser wizard with no API to skip it. Three of those flags are
load-bearing:

- **`--api_enabled`** is what the GReader endpoint hangs off. Without it every
  API call answers HTTP 503, which reads like the server being down rather than
  like a setting being off.
- **`--api_password` is not `--password`.** The account password signs in to the
  web interface; the API password is a separate value, and using the account
  one produces a 401 that says nothing about which of the two it wanted.
- **`--base_url`** has to match the URL the suite uses, or FreshRSS builds
  absolute links pointing somewhere else.

The feed the suite subscribes to is served by a **second container** on the
compose network. FreshRSS's own default subscription points at github.com,
which would make every run depend on somebody else's uptime, on being polite to
them, and on the machine having outbound internet at all — none of which has
anything to do with this server.

The assertion worth keeping is the unread **count**. FreshRSS answers `OK` to a
mark request whether or not it recognised the article ids, so a wrong id
conversion — GReader's wire form is `tag:google.com,2005:reader/item/<16 hex>`
and the write endpoints want the decimal value — is completely silent. The
count moving is the only thing that shows it worked.

For poking at one tool by hand, the inspector against the same stack:

```sh
docker compose -f test/integration/compose.yml up -d
FRESHRSS_URL=http://127.0.0.1:8081 FRESHRSS_USER=integration \
  FRESHRSS_API_PASSWORD=integration-api-not-a-secret \
  npx @modelcontextprotocol/inspector node dist/index.js
```

## Expectations

- **Tests.** Behaviour changes come with a test that fails without the change.
  CI runs lint, build and the test suite on Node 22 and 24, plus `npm audit`, CodeQL and a
  Trivy scan of the container image on amd64 and arm64.
- **Comments** explain constraints the code cannot show — not what the next line does.
- **Security-sensitive areas** (config parsing, confirmation tokens, anything that
  builds a request URL): please describe the attack you are defending against, or the
  one your change might open, in the PR text.
- **No new runtime dependencies** without a very good reason; the small tree is a
  feature.
- Run `npm run lint` before pushing — it checks both oxlint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/freshrss-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/freshrss-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/freshrss-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
