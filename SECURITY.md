# Security policy

## Reporting a vulnerability

Please use [GitHub private vulnerability reporting](https://github.com/ni-c/freshrss-mcp/security/advisories/new).
Do not open a public issue for an unpatched vulnerability, and do not include real
credentials, tokens, hostnames or private configuration in a report.

You can expect an initial response within a week. Fixed vulnerabilities are published
as a new release with a note in the CHANGELOG.

## Supported versions

Only the latest release and the current `main` branch receive security fixes.

## Trust model

The credentials this server holds are a FreshRSS user name and that user's **API
password**. Together they grant, through the Google Reader compatible API, everything
that user can do in the web interface: read every article the account has stored,
change read state and stars, subscribe and unsubscribe, and rename or delete
categories and labels. Deleting a feed also deletes its stored articles, which
FreshRSS cannot undo.

Two things are worth calling out because they are not obvious:

- **Feed URLs can themselves contain credentials.** FreshRSS stores HTTP-auth feeds as
  `https://user:password@host/feed`. This server redacts the userinfo part before any
  feed URL reaches a tool result or the OPML export, but the FreshRSS instance still
  holds the original.
- **`subscribe_feed` and `import_opml` make the FreshRSS server fetch a URL.** Those
  are server-side requests, so they are refused for loopback and link-local addresses
  (including cloud metadata endpoints) — the feed URL for `subscribe_feed`, every
  `xmlUrl` and `htmlUrl` for `import_opml`. Private LAN addresses are allowed, because
  self-hosted setups legitimately subscribe to feeds on their own network.

  A literal is decided numerically, so notations that spell the same address
  differently (`[::ffff:127.0.0.1]`, `localhost.`) do not get past it. A hostname is
  additionally resolved and its addresses are checked, which stops the obvious
  `feed.example.com A 127.0.0.1` case — but that half is a barrier, not a boundary:
  a name this process cannot resolve is passed on (the FreshRSS server may sit in a
  different network with its own resolver), FreshRSS resolves the name again when it
  fetches, and a redirect or a feed link discovered on the fetched page is a URL this
  server never saw. The boundary that holds is where FreshRSS itself stands on the
  network.

The API password is separate from the web login password and can be rotated on its own
in **Settings -> Profile -> API management**, which is the fastest containment step if
you suspect exposure. Setting `FRESHRSS_READ_ONLY=true` registers only the read tools,
so no write tool exists to be called at all.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Five operations **ask a person** through MCP elicitation: `mark_all_as_read`,
`unsubscribe_feed`, `delete_category_or_label`, `import_opml`, and `mark_articles`
when it is about to mark something read. That is a dialog raised by the server and
shown by the client, which the model cannot answer on its behalf; nothing happens
until an answer comes back, and the approval is bound to the exact target.

Where the client cannot show a dialog they fall back to a server-generated token
bound the same way. That fallback is weaker and this server says so rather than
implying somebody approved: it proves the call was made twice with the same
arguments, and nothing more. `ELICITATION=false` moves a capable client onto it
deliberately — it does not remove the guard, and the server prints one line at
startup saying it is off.

Data returned from the upstream API is untrusted input: it is marked as such, and
confirmation prompts never quote it in the server's own sentence. Where a value the
caller chose has to appear at all — the feed hosts an OPML import would subscribe
to — it goes on a separate line under "Values below are supplied by the caller",
where the approval library flattens it to one line and caps it. That cap is the
point: a hostname has no length limit of its own, and thousands of characters of
readable, attacker-written prose inside the question would push the consequence
out of view in any dialog that renders it.

## What an approval binds

An approval binds a **decision to a request**. The sealed request state carries the
resource key, so an answer cannot be moved from the question it was given to a
different one: confirming an import of a three-feed OPML document does not
authorise importing another, because the exact document is what the key is built
from.

What a sealed state does not prove is **freshness**. "This answer belongs to this
question" and "this answer has not been used already" are different properties, and
only the first one exists. That gap is not reachable on this server today, and the
reasons are worth writing down rather than rediscovering:

- **The dialog never leaves the process.** `src/index.ts` connects with
  `server.connect(new StdioServerTransport())`, which pins the connection to
  protocol revision `2025-11-25`. Asked for `2026-07-28`, with and without the
  modern `_meta` envelope, this server still answers `2025-11-25`. On that revision
  the SDK bridges the elicitation server-side inside the same `tools/call`: the
  question goes out, the answer comes back, and the sealed state is never handed to
  the caller. There is no artefact to keep, so there is nothing to replay.
- **The token fallback is single-use by construction.** A matching token is spent
  as it is checked, and issuing a new one for the same resource key replaces any
  pending one. A second call carrying a spent token is refused. Its weakness is the
  different one stated above — it proves the call was made twice, not that a person
  saw it.

**On the day this server speaks `2026-07-28`** — which means moving `src/index.ts`
onto `serveStdio`, the entry point that lets the opening exchange select the era —
the sealed state does travel, and a replay window opens with it: the caller then
holds a state that stays valid for its whole lifetime and could present the same
approved answer again for a second call with the same arguments. What would have to
be built on that day is a record of spent states — the resource key together with a
nonce from the state, kept until that state expires and checked before an answer is
accepted, which is what the token store already does for tokens. None of it exists
now, on purpose: an unreachable mechanism is one more thing that has to stay
correct, and this paragraph is the reminder to build it at the moment it starts to
matter.
