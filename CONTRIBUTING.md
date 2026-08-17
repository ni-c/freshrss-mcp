# Contributing

Thanks for taking the time. Small, focused changes with tests land fastest.

## Development setup

```sh
git clone https://github.com/ni-c/freshrss-mcp.git && cd freshrss-mcp
npm install
npm test          # no instance needed, the FreshRSS API is stubbed
npm run build
```

A minimal dev environment:

```sh
# A throwaway FreshRSS to develop against. Enable the API afterwards under
# Settings -> Authentication -> "Allow API access", then set an API password
# under Settings -> Profile -> API management.
docker run --rm -p 8013:80 -e TZ=Europe/Berlin freshrss/freshrss:latest

export FRESHRSS_URL=http://localhost:8013
export FRESHRSS_USER=dev
export FRESHRSS_API_PASSWORD=...     # the API password, not the login password
node dist/index.js
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
- Run `npm run lint` before pushing — it checks both eslint and prettier, and prettier
  also validates the YAML, JSON and Markdown files.

## Questions and bugs

- Questions and ideas → [Discussions](https://github.com/ni-c/freshrss-mcp/discussions)
- Reproducible problems → [Issues](https://github.com/ni-c/freshrss-mcp/issues)
- Vulnerabilities → [private reporting](https://github.com/ni-c/freshrss-mcp/security/advisories/new),
  never a public issue — see [SECURITY.md](SECURITY.md)
