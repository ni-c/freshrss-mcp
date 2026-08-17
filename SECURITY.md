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
- **`subscribe_feed` makes the FreshRSS server fetch a URL.** That is a server-side
  request, so it is refused for loopback and link-local addresses (including cloud
  metadata endpoints). Private LAN addresses are allowed, because self-hosted setups
  legitimately subscribe to feeds on their own network.

The API password is separate from the web login password and can be rotated on its own
in **Settings -> Profile -> API management**, which is the fastest containment step if
you suspect exposure. Setting `FRESHRSS_READ_ONLY=true` registers only the read tools,
so no write tool exists to be called at all.

Treat every environment variable this server reads as a secret. The MCP client
process, and therefore the model driving it, sees every tool result — do not point
this server at a system whose data you would not put in a model's context.

Destructive operations require a server-generated confirmation token that is bound to
the specific target; a model cannot satisfy that gate on its own. Data returned from
the upstream API is untrusted input: it is marked as such, and confirmation prompts
never quote it.
