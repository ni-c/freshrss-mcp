# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

<!-- The release workflow extracts the section of the version being tagged with awk,
     matching "## [x.y.z]". Keep that heading shape exactly. -->

<!-- #region changelog -->

## [Unreleased]

### Added

- Every tool declares an `outputSchema` and answers with `structuredContent`
  beside the text block. A client no longer has to parse prose to use a result —
  which six of them made unavoidable, since they answered with a sentence. The
  sentence stays, in the text block.

  Every tool that reports feed content carries `untrusted: true` and
  `source: "freshrss"` as fields. This server has always said so in `notes`,
  which is prose in a list: a client can read it and cannot check it. Eight
  tools are without the marker, because their answer is entirely this server's
  own words — ids it was given, a sentence built from the arguments, the account
  it authenticates as.

### Changed

- The advertised schemas avoid spellings that are legal JSON Schema and still
  get a tool refused, or its constraint silently dropped, by some MCP clients:
  an open object now writes `"additionalProperties": true` rather than the
  empty schema `{}` zod emits for it; and a value that was left untyped is
  declared as what it really is. What the tools accept and return is unchanged;
  only the way the schema says so is.

- `export_opml` answers `{opml}` instead of the document as the whole result. A
  schema whose root is a string is served to a 2025-era client rewritten as
  `{result: …}`, so the tool would have answered in two shapes depending on
  which revision the client spoke — and `truncated` now has somewhere to live.

- A result too large even after article content is dropped is now an error. It
  used to answer with the JSON cut at the ceiling, which a text block tolerates
  and `structuredContent` cannot.

- The two-call `confirm_token` prompt is an error result. What was asked for did
  not happen, which is what `isError` says. The text is unchanged and still
  carries the token.

### Added

- The four tools that need a confirmation now **ask the user**, on clients that
  can show a prompt: `unsubscribe_feed`, `mark_all_as_read`,
  `delete_category_or_label` and `import_opml`. The two-call `confirm_token`
  remains for clients that cannot, so nothing that works today stops working —
  but where a person can be asked, one is, instead of a token that only proves
  the same call was made twice.

- Each of those prompts now says what will be lost, which three of the four
  never did: FreshRSS keeps no record of which articles were unread, a feed takes
  its stored articles with it, and a deleted category moves its feeds to the
  default rather than deleting them.

- **`mark_articles` now asks too — but only when it is about to mark something
  read.** It carries `destructiveHint: true` and went through unannounced, and
  its own description claimed "All changes are reversible by calling this tool
  again with the opposite value." Three of the four are. Which of those articles
  were unread is not, and FreshRSS keeps no record of it — the same reason
  `mark_all_as_read` is guarded, over a caller-named list instead of a whole
  stream.

  Starring, unstarring, labelling and marking _unread_ still go straight
  through. Asking about a star toggle as well would be how people learn to tick
  without reading. The approval is bound to the exact list of `article_ids`, so
  one obtained for three articles does not execute against thirty.

- `ELICITATION` switches the dialog off — `false` sends a client that could have
  been asked down the two-call-token path instead. For a scheduled job or a test
  harness, where a dialog is the wrong shape rather than an unwanted one.

  It does **not** remove the guard: there is no setting in which a guarded call
  goes unannounced. Two deliberate rough edges come with it. The variable is
  **not prefixed**, so one `export ELICITATION=false` reaches every MCP server in
  the environment — which is why a server started with it off prints a line
  saying so, and why the fallback text names the server instead of blaming a
  client that was working fine. And a value that is neither `true` nor `false`
  **stops the server**: it is the only variable here that defaults to _on_, so
  failing open on a typo would leave the dialog running while the operator
  believed it was off. It is read after `FRESHRSS_API_PASSWORD` is wiped from the
  environment, so that exit cannot leave the password behind.

- A `docs/guide/approval.md` page.

- `SECURITY.md` states what an approval binds — a decision to a request, not a
  decision to a moment — why the freshness gap that leaves is unreachable on this
  server today, and what would have to be built on the day it starts speaking
  protocol revision `2026-07-28`.

- The live suite now pins three refusals against a real FreshRSS as well as the
  happy paths: the SSRF guard on `subscribe_feed` and on `import_opml`, each
  asserted with its reason rather than with a bare "this failed", and a
  read-only server registering no write tool.

### Changed

- A `confirm_token` that does not match its arguments is **refused with the
  reason** instead of being answered with a fresh prompt, and the confirmation
  prompt itself is a plain result rather than an error. Both are now the same in
  every server of the family.

- Runs on **MCP SDK 2.0**. Existing clients see the same protocol revision they
  always did; the change is the package layout behind it, and it is what lets
  the dialog above work on both protocol eras from one code path — including
  behind a stateless gateway, where the older mechanism silently fell back to
  the weaker token for every client.

- The linter is **oxlint** instead of eslint plus typescript-eslint, which lifts
  the TypeScript ceiling: typescript-eslint pins `typescript` below 6.1, so this
  repository was held on TypeScript 6 by its linter rather than by its code.

- The tool filter, the confirmation store, the host guard and the
  documentation-asset generator now come from **`mcp-tool-allowlist`**,
  **`mcp-approval`**, **`mcp-internal-hosts`** and **`svg-asset-set`** rather
  than from copies kept here — 825 fewer lines, and one place to fix each. None
  of them has a runtime dependency of its own.

  The SSRF guard is the notable one: what leaves is the classification and the
  resolving, including the two rules this repository contributed upstream — a
  resolver answering `0.0.0.0` is declining rather than pointing at the fetching
  host, and a name that does not resolve is passed on. What stays is the
  refusal, in FreshRSS's own words. The behaviour is unchanged, and
  `import_opml` now stops resolving as soon as one host is refused instead of
  spending the whole ten-second budget to reach the same answer.

- The shared libraries move to `mcp-approval` 0.7.1, `mcp-tool-allowlist` 0.2.1,
  `mcp-internal-hosts` 0.2.1, `mcp-integration-harness` 0.2.0 and
  `svg-asset-set` 0.2.0.

- stdio is served through `serveStdio`, so the connection's era is negotiated
  on the opening exchange rather than assumed. A client that pins the
  `2026-07-28` era is served it; until now its `server/discover` probe was
  answered with "Method not found" and only `2025-11-25` was on offer. A client
  that speaks the older era sees no change — it is still pinned to one instance
  for the life of the connection, exactly as a hand-wired
  `StdioServerTransport` served it.

### Fixed

- **A feed could stall the server with an article body that shows nothing.**
  Markup was removed with `replace(/<[^>]+>/g, '')` inside a loop that repeated
  until the text stopped changing. Every `<` with no `>` behind it made `[^>]+`
  run to the end of the input and then backtrack a character at a time, so an
  article could buy quadratic work with linear bytes — measured at 8.8 seconds
  per article for 122 048 bare `<a`s, 40 seconds for a body of bare `<`s, on the
  single thread that also serves every other request. The reachable form of it
  needs no invalid markup at all: `&lt;a` repeated is escaped _text_, which
  nothing on the FreshRSS or SimplePie path has reason to touch, and the
  conversion decodes entities between its two passes.

  The conversion is now a single left-to-right scan: at a `<` it looks for the
  `>` that closes it, discards the span, and never re-reads what it deleted. The
  repeat-until-stable loop is gone with it — a scan cannot splice `<scr<script>`
  into a new tag, because it reads the fragment and the tag that follows it in
  one direction, which is what a browser's tokeniser does with the same bytes.
  The same payloads now take single-digit milliseconds.

- **The response budget is charged for the markup read, not the text returned.**
  This was the amplifier under the entry above: a body that strips away to
  nothing produced no output, so nothing was debited, the budget stayed whole,
  and every one of the up to 100 articles in the same `list_articles` response
  was handed a full slice again. An article that fills its slice now costs the
  per-article limit it was given, whatever came out — which is what the README
  claimed of the budget all along.

- **A feed password containing an `@` was published in half.** The redaction
  matched up to the _first_ `@`, but userinfo ends at the last one before the
  path, and FreshRSS does not percent-encode the password it stores. A feed
  stored as `https://alice:p@ssw0rd@rss.example/feed` came back as
  `https://***@ssw0rd@rss.example/feed` from `list_feeds` and the OPML export —
  the exact disclosure the redaction exists to prevent. `https://host/users/@alice`
  is still left alone.

- **A hostname can no longer crowd out the `import_opml` confirmation dialog.**
  The hosts an OPML document points at were interpolated into the server's own
  question. `URL.hostname` has no length limit — IDNA is applied with
  `VerifyDnsLength=false`, so a single 5 000-character label parses and survives
  — so eight of them put tens of thousands of characters of readable,
  attacker-written text into the question, ahead of the consequence line, which
  every renderer would then push out of view. The question now states how many
  hosts there are; the names go on the caller-supplied line, where the approval
  library flattens and caps them.

- **`FRESHRSS_READ_ONLY` is read tolerantly, as a protection switch should be.**
  It was compared with `=== 'true'`, so `=1`, `=yes`, `=TRUE` or a trailing space
  started a server with every write tool registered and said nothing about it —
  the operator asked for the guard and had no way to learn they had not been
  given one. `1`, `true` and `yes` now all switch it on, in any casing, with
  surrounding whitespace ignored. `FRESHRSS_INSECURE_TLS` stays strict on
  purpose: that one _lifts_ a protection, so a value nobody spelled exactly has
  to leave certificate validation on.

- Confirmation tokens are compared with a **constant-time** comparison. The copy
  in this repository used `!==`, which leaks through timing how much of a guess
  was right. Reaching a token still requires having received it in a previous
  tool result, so this closes a margin rather than a hole.

- An entry in `FRESHRSS_ALLOW_TOOLS` that is not tool-name-shaped is now
  **redacted** in the error rather than quoted back. `FRESHRSS_API_PASSWORD` and
  `FRESHRSS_ALLOW_TOOLS` are adjacent lines in every compose file, and a paste
  into the wrong one used to print the credential into the client's log.

## [0.2.0] - 2026-08-27

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

### Changed

- The README now carries the same eight badges, in the same order, as every other
  MCP server in this family, all of them reading from npm rather than hard-coded;
  the opening follows one shape; and the standalone "Full documentation" line is
  gone, because the docs badge three lines above it points at the same page.

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
