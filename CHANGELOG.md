# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- #region changelog -->

## [Unreleased]

### Added

- `FRESHRSS_ALLOW_TOOLS` and `FRESHRSS_DENY_TOOLS` choose which of the 16
  tools are registered. Both take comma-separated tool names or a prefix with a
  trailing `*`, the allow list decides what is in and the deny list is subtracted
  from it, and `FRESHRSS_ALLOW_TOOLS=essential` selects a curated seven —
  `list_feeds`, `list_categories`, `get_unread_counts`, `list_articles`, `get_articles`, `mark_articles`, `mark_all_as_read`. A model picks the right tool far more reliably from seven than
  from sixteen, and every visible tool costs context on every request. Nothing
  changes for an installation that sets neither.

  A filtered tool is not registered at all, so it is absent from `tools/list`
  and answers `tools/call` with "tool not found" — the same cut
  `FRESHRSS_READ_ONLY` already makes, not a second, weaker one.

  An entry that matches no tool **stops the server at startup**, naming the
  entry and listing the real names, rather than being ignored: an ignored typo
  leaves a tool missing from `tools/list` with nothing pointing at the cause.

### Fixed

- The container image no longer ships OpenSSL 3.5.7-r0, which carries
  **CVE-2026-14456** (denial of service via unbounded memory growth). The pinned
  `node:24-alpine` digest is already the newest one; Alpine's fixed 3.5.8-r0 has
  simply not been rebuilt into it yet, so the runtime stage now upgrades
  `libcrypto3` and `libssl3` by name. Upgrading those two rather than running a
  blanket `apk upgrade` keeps the rest of the image exactly as the digest pins
  it. The step can go once the base image ships the fix.

## [0.1.6] - 2026-08-26

### Fixed

- A feed whose domain a resolver sinkholes is no longer refused. Every ad
  blocker and DNS filter answers `0.0.0.0` for a blocked name, and `0.0.0.0/8`
  classifies as loopback — so 0.1.5 turned "your resolver blocks this domain"
  into "refusing to point FreshRSS at a loopback address", which was both wrong
  and unhelpful. A resolved unspecified address is now passed over; nothing can
  be fetched from it. `0.0.0.0` written into the URL itself is still refused,
  because that one does address the host.
- An IPv6 scope id is stripped before the address is read. `net.isIP` accepts
  `::ffff:127.0.0.1%eth0`, which made the dotted-quad fold miss its anchor and
  the address come out as routable. A URL cannot carry one, but a resolver
  answer can.
- A group of an IPv6 literal that is not hexadecimal is rejected outright rather
  than handed to `parseInt`, which stops at the first character it dislikes and
  returns a number for `7f00xyz` just as happily.

### Security

- The metadata endpoints outside `169.254/16` are refused as well:
  `100.100.100.200` (Alibaba Cloud) and `192.0.0.192` (Oracle's legacy
  endpoint). Neither is link-local by address, so no range check reaches them,
  but both are the same thing by purpose.

## [0.1.5] - 2026-08-25

### Security

- `subscribe_feed` no longer accepts a loopback or link-local address written as
  an IPv4-mapped IPv6 literal. `URL` canonicalises `http://[::ffff:127.0.0.1]/`
  into `[::ffff:7f00:1]` and `http://[::ffff:169.254.169.254]/` into
  `[::ffff:a9fe:a9fe]` before the guard saw them, so the string comparison found
  nothing it recognised and approved both — while every dual-stack client dials
  them as `127.0.0.1` and the cloud metadata service. Addresses are now reduced
  to the IPv4 address they carry and compared numerically, which also covers the
  IPv4-compatible, IPv4-translated and NAT64 forms. `localhost.` with the root
  label got past the same comparison and is now read as `localhost`.
  ([GHSA-qqh2-7466-82f8](https://github.com/ni-c/freshrss-mcp/security/advisories/GHSA-qqh2-7466-82f8))
- `import_opml` now checks the URLs in the document. `/subscription/import` makes
  FreshRSS subscribe to every `xmlUrl` and fetch it server-side — the same
  capability `subscribe_feed` guards, reached through a door that had no check on
  it at all. Every `xmlUrl` and `htmlUrl` is now held to the same rule, entity
  references are resolved first (as libxml does), and a scheme other than
  http/https is refused rather than left to FreshRSS to open.
  ([GHSA-qqh2-7466-82f8](https://github.com/ni-c/freshrss-mcp/security/advisories/GHSA-qqh2-7466-82f8))
- The attributes of an imported OPML document are read by walking it the way an
  XML parser does, not by searching for them with a regular expression. A regex
  pairs quotes by scanning raw text, so a literal `xmlUrl="` planted inside a
  single-quoted attribute value or inside a comment made it pair the wrong
  quotes: it would have read a harmless decoy host while libxml, which parses the
  document on the FreshRSS side, read the loopback URL next to it. A document
  that does not scan as well-formed XML is now refused rather than guessed at.
- A hostname that is not a literal address is resolved and its addresses are
  checked, so a DNS record pointing at `127.0.0.1` or `169.254.169.254` no longer
  walks around the guard. A name that cannot be resolved here is still passed on:
  the FreshRSS server may sit in a different network with its own resolver.
- An imported OPML document is now sent with its encoding declaration rewritten
  to UTF-8, which is what the body is actually encoded as. libxml believes the
  declaration over the bytes, so `<?xml version="1.0" encoding="UTF-7"?>` made it
  read `+AHg-mlUrl="http://127.0.0.1/"` as `xmlUrl="http://127.0.0.1/"` — an
  attribute no check reading the document as text can see under that name. The
  same trick hid a `<!DOCTYPE>` from the declaration check, putting entity
  expansion and external entities back on the table.
- The URLs that were checked are written back into the document before it is
  sent, the way `subscribe_feed` hands FreshRSS the parsed URL rather than the
  string it was given. Checking one document and forwarding another is what let
  `http://ok.example.com\@127.0.0.1/feed` past: a URL parser reads its host as
  `ok.example.com`, the fetcher splits at the `@` and connects to `127.0.0.1`.
- An `xmlUrl` behind a namespace prefix (`o:xmlUrl`) is matched on its local
  name, which is the name libxml reports it under.
- The names of the cloud metadata service — `metadata.google.internal`,
  `instance-data` and their siblings — are refused by name. They resolve to
  `169.254.169.254` on the instance and to nothing anywhere else, so resolving
  them is exactly what cannot catch them.

### Changed

- The `import_opml` confirmation prompt names the hosts the document would
  subscribe to instead of only counting its outline elements, and a document that
  will be refused no longer gets a confirmation token first.
- An `xmlUrl` written as `//host/path` is read as the http URL it stands for, and
  a relative one is left to FreshRSS — both appear in real OPML exports and must
  not fail an otherwise valid import. `feed://` is refused, the way
  `subscribe_feed` already refused it: reading it as `http://` would quietly
  fetch over plaintext a feed that is served over https.

## [0.1.4] - 2026-08-24

### Fixed

- Article text no longer comes back with HTML in it. Entities were decoded
  after the tags had already been stripped, so any encoding of `<script>` —
  `&lt;`, `&#60;` or `&#x3c;` — was rebuilt verbatim in the output, event
  handler attributes along with it. Markup is now removed again after decoding,
  repeatedly, until nothing changes.
- A `<script>` whose closing tag falls outside the parsed slice no longer
  delivers its JavaScript as article text, and a tag cut in half by that slice
  no longer survives as a fragment.

## [0.1.3] - 2026-08-18

### Fixed

- `http://[::1]:…` no longer produces the "plain http to a non-local host, the
  API password will be sent unencrypted" warning. `URL.hostname` keeps the
  brackets around an IPv6 literal, so the loopback check never matched that
  notation.

## [0.1.2] - 2026-08-18

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

<!-- #endregion changelog -->
