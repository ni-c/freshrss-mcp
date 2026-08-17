---
layout: home
hero:
  name: 'freshrss-mcp'
  text: 'Your feed reader, spoken to'
  tagline: 'An MCP server for FreshRSS: list feeds, read and triage articles, manage subscriptions and categories — from Claude, Codex or any MCP client.'
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Tools reference
      link: /reference/tools
    - theme: alt
      text: GitHub
      link: https://github.com/ni-c/freshrss-mcp
features:
  - title: Sixteen tools, no stream ids
    details: The Google Reader API speaks in stream identifiers and hexadecimal item tags. These tools take numeric feed ids, category and label names, ISO dates and decimal article ids, and hand back plain text instead of raw HTML.
  - title: Runs anywhere stdio does
    details: A single npx command, a Claude Desktop JSON block, a Codex TOML entry, or a multi-arch container image with an SBOM and build provenance.
  - title: Built for untrusted feeds
    details: Every article was written by a stranger on the internet, so responses are marked as data, destructive tools need a server-issued token, feed URLs are stripped of credentials, and article text is capped per article and per response.
---

<!-- SYNC: this inline SVG and public/architecture.svg show the same diagram.
     The inline copy uses CSS variables so it follows the theme toggle; the
     standalone file uses a prefers-color-scheme media query because README and
     npm embed it as an image. Change both. -->

<figure class="diagram">
<svg viewBox="0 0 760 250" role="img" aria-labelledby="arch-title arch-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="arch-title">freshrss-mcp architecture</title>
  <desc id="arch-desc">An MCP client speaks stdio to freshrss-mcp, which calls the Google Reader compatible API of FreshRSS over HTTPS using a GoogleLogin auth token; FreshRSS polls the subscribed feeds.</desc>

  <defs>
    <marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" />
    </marker>
    <marker id="arrow-accent" class="accent" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L8,3 z" />
    </marker>
  </defs>

  <rect class="node" x="14" y="62" width="164" height="80" rx="10" />
  <text class="label-title" x="96" y="93" text-anchor="middle">MCP client</text>
  <text class="label-muted" x="96" y="113" text-anchor="middle">Claude, Codex, Inspector</text>

  <rect class="node-accent" x="248" y="62" width="180" height="80" rx="10" />
  <text class="label-title" x="338" y="93" text-anchor="middle">freshrss-mcp</text>
  <text class="label-muted" x="338" y="113" text-anchor="middle">16 tools, zod-validated</text>

  <rect class="node" x="498" y="62" width="164" height="80" rx="10" />
  <text class="label-title" x="580" y="93" text-anchor="middle">FreshRSS</text>
  <text class="label-muted" x="580" y="113" text-anchor="middle">/api/greader.php</text>

  <rect class="node" x="498" y="178" width="164" height="54" rx="10" />
  <text class="label-title" x="580" y="203" text-anchor="middle">Feeds</text>
  <text class="label-muted" x="580" y="221" text-anchor="middle">RSS / Atom sources</text>

  <path class="edge-accent" d="M178,102 L242,102" marker-end="url(#arrow-accent)" />
  <text class="label-mono" x="210" y="90" text-anchor="middle">stdio</text>

  <path class="edge-accent" d="M428,102 L492,102" marker-end="url(#arrow-accent)" />
  <text class="label-mono" x="460" y="90" text-anchor="middle">HTTPS</text>
  <text class="label-muted" x="460" y="126" text-anchor="middle">GoogleLogin</text>

  <path class="edge edge-dashed" d="M580,142 L580,172" marker-end="url(#arrow)" />

<text class="label-muted" x="338" y="164" text-anchor="middle">confirm tokens · redaction · response budget</text>
</svg>
<figcaption>The server holds no state beyond cached auth tokens and short-lived confirmation tokens; FreshRSS remains the source of truth, and it is what polls the feeds.</figcaption>
</figure>
