# Connecting clients

Every snippet below assumes the API is enabled and you have an API password — see
[Getting started](/guide/getting-started).

## Claude Code

```sh
claude mcp add freshrss \
  -e FRESHRSS_URL=https://rss.example.com \
  -e FRESHRSS_USER=alice \
  -e FRESHRSS_API_PASSWORD=... \
  -- npx -y @ni-c/freshrss-mcp
```

Then `/mcp` in a session to confirm it connected.

## Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "npx",
      "args": ["-y", "@ni-c/freshrss-mcp"],
      "env": {
        "FRESHRSS_URL": "https://rss.example.com",
        "FRESHRSS_USER": "alice",
        "FRESHRSS_API_PASSWORD": "..."
      }
    }
  }
}
```

## Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.freshrss]
command = "npx"
args = ["-y", "@ni-c/freshrss-mcp"]
env = { FRESHRSS_URL = "https://rss.example.com", FRESHRSS_USER = "alice", FRESHRSS_API_PASSWORD = "..." }
```

## MCP Inspector

Useful for poking at tools without a model in the loop:

```sh
npx @modelcontextprotocol/inspector npx -y @ni-c/freshrss-mcp
```

## Docker

```sh
docker run --rm -i \
  -e FRESHRSS_URL=https://rss.example.com \
  -e FRESHRSS_USER=alice \
  -e FRESHRSS_API_PASSWORD=... \
  ghcr.io/ni-c/freshrss-mcp:latest
```

`-i` is required: the transport is stdio, so without an attached stdin the server
exits immediately. The image is published for `linux/amd64` and `linux/arm64` with
an SBOM and build provenance, runs as the unprivileged `node` user, and contains no
npm — only Node, the runtime dependencies and `dist/`.

If your FreshRSS is on the same Docker network, address it by container name and
remember it will be plain HTTP:

```sh
docker run --rm -i --network freshrss_default \
  -e FRESHRSS_URL=http://freshrss \
  -e FRESHRSS_USER=alice \
  -e FRESHRSS_API_PASSWORD=... \
  ghcr.io/ni-c/freshrss-mcp:latest
```

The server warns on stderr when it sends credentials over plain HTTP to a
non-loopback host. Inside a private Docker network that is a considered trade-off;
across the internet it is not.

## Through mcp-hub

[mcp-hub](https://mcp-hub.ni-c.de) serves many stdio MCP servers from one container
behind a single HTTPS endpoint, so freshrss-mcp can be reached from clients that cannot
spawn a local process — ChatGPT connectors, Claude on the web, Cursor — without a
container, a hostname and an OAuth stack of its own.

Its `/config/mcp.json` uses Claude Code's format, so the entry is the one you
already have, with the hub's own filter alongside:

```json
{
  "mcpServers": {
    "freshrss": {
      "command": "npx",
      "args": ["-y", "@ni-c/freshrss-mcp"],
      "env": { "FRESHRSS_ALLOW_TOOLS": "essential" },
      "denyTools": ["delete_*"]
    }
  }
}
```

`allowTools` and `denyTools` are the hub's **own** per-server filter and take exact
tool names or `list_*` prefixes — the same syntax as the two environment variables,
so a list moves between them verbatim. What does **not** move is `essential`: that
preset is a freshrss-mcp feature and belongs in `env` as shown.
`"allowTools": ["essential"]` would be a name the hub cannot resolve.

The two compose, and it is worth knowing which does what: the server registers what
its environment variables allow, and the hub exposes what its arrays allow.
Filtering in the server is the tighter of the two — the tool is never built.

Register `https://your-host/freshrss/mcp` as a connector and you
get this server alone. Register the hub's `/hub` endpoint instead and you reach
_every_ server behind it through six meta-tools, which is the answer worth having
once you run several of these at once.

## Next

- [Configuration](/guide/configuration) — every environment variable
- [Tools reference](/reference/tools)
