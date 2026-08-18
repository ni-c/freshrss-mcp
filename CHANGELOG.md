# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

## [Unreleased]

### Fixed

- The architecture diagram and the demo recording were not displayed at all — on
  GitHub or on npm. GitHub Pages had never issued the TLS certificate for
  freshrss-mcp.ni-c.de (`https_enforced` was `false`, the only repository where it
  was), so every image embedded from that domain was proxied by camo and answered
  with 502. The certificate has been reissued and HTTPS is enforced.
- The architecture diagram no longer depends on the reader's operating system. It
  carried a `prefers-color-scheme` block, which resolves against the OS rather than
  the theme toggle of GitHub or npm — so dark-mode readers on a light OS got the
  light artwork on a dark page, and this diagram painted an opaque white rectangle
  over the full canvas, which is the worst case there. The README now uses
  `<picture>`, which is resolved against the page, and the `<img>` that npm falls
  back to brings its own card instead of a media query.
- The documentation site declared no `og:image` at all, so links to it had no
  preview card anywhere.

### Changed

- The diagram is generated from a single source, `docs/assets/architecture.source.svg`,
  by `npm run assets`. The rendered copies had already drifted apart; CI now fails
  if one of them is edited by hand.
- `docs/public/og.png` is generated at exactly 1280x640, GitHub's recommended size
  for a social preview.
- The demo recording is shown on the documentation home page as well, not only in
  the README, and is pinned to the content column so its width no longer depends on
  what the vhs tape happened to record.
- The TypeScript major is now parked in `.github/dependabot.yml` with its reason,
  instead of living only as an `@dependabot ignore` on the closed PR #1.

## [0.1.1] - 2026-08-17

### Changed

- First release published by CI, so this is the first version carrying npm
  provenance attestations, a GitHub release generated from this file, and an
  entry in the MCP Registry. 0.1.0 was published by hand to claim the package
  name and is functionally identical; prefer this version if you verify
  provenance.

## [0.1.0] - 2026-08-17

### Added

- Initial release: MCP server for FreshRSS, speaking the Google Reader
  compatible API at `/api/greader.php`.
- Read tools: `get_user_info`, `list_feeds`, `list_categories`,
  `get_unread_counts`, `list_articles`, `get_articles`, `list_article_ids`,
  `export_opml`.
- Write tools: `mark_articles`, `mark_all_as_read`, `subscribe_feed`,
  `update_feed`, `unsubscribe_feed`, `rename_category_or_label`,
  `delete_category_or_label`, `import_opml`. Not registered when
  `FRESHRSS_READ_ONLY=true`.
- Confirmation tokens for `mark_all_as_read`, `unsubscribe_feed`,
  `delete_category_or_label` and `import_opml`.
- Plain-text conversion of article HTML with per-article and per-response size
  budgets.
- Credentials embedded in feed URLs (`https://user:password@host/feed`, how
  FreshRSS stores HTTP-auth feeds) are redacted in `list_feeds` and
  `export_opml`.
- `subscribe_feed` refuses loopback and link-local targets: FreshRSS fetches the
  URL server-side, so the tool would otherwise be an SSRF primitive reachable
  from text inside an article. Private LAN addresses stay allowed.
- `import_opml` refuses documents with a `<!DOCTYPE>` or `<!ENTITY>`
  declaration, which is what carries entity-expansion and external-entity
  attacks into the FreshRSS server's XML parser.
- Multi-architecture container image on `ghcr.io/ni-c/freshrss-mcp` with an SBOM
  and build provenance. npm is removed from the runtime image — it is unused
  there, and its vendored dependencies were the image's only HIGH/CRITICAL CVEs.
- CI: lint, build and tests on Node 22 and 24, `npm audit`, CodeQL, and a Trivy
  scan of the image on amd64 and arm64. Releases publish to npm via Trusted
  Publishing with provenance and register with the MCP Registry.
