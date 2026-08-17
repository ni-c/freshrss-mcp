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

## Next

- [Configuration](/guide/configuration) — every environment variable
- [Tools reference](/reference/tools)
