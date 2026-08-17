# Getting started

## Requirements

- Node.js 22 or newer (24 recommended — it is the active LTS line)
- A FreshRSS instance, developed and verified against 1.29

## 1. Enable the API in FreshRSS

Two separate settings, and both are needed:

1. **Settings → Authentication →** tick **"Allow API access"**.
2. **Settings → Profile → API management →** set an **API password**.

::: warning The API password is not your login password
FreshRSS stores it separately (as `apiPasswordHash`) and the Google Reader API only
ever checks that one. Using the web login password produces a 401 that looks like a
typo. The upside: you can rotate the API password on its own without touching your
own login.
:::

## 2. Check it from the shell

Before wiring up a client, confirm the API answers. `ClientLogin` returns three
lines of plain text and the `Auth=` value is the token every later call carries:

```sh
curl -s -X POST \
  -d 'Email=alice' -d 'Passwd=YOUR_API_PASSWORD' \
  https://rss.example.com/api/greader.php/accounts/ClientLogin
```

- `Auth=alice/…` — working.
- `HTTP 401` — wrong password, or you used the login password.
- `HTTP 503` — the API is disabled; go back to step 1.
- An HTML page — `FRESHRSS_URL` is not the instance root.

## 3. Run the server

```sh
FRESHRSS_URL=https://rss.example.com \
FRESHRSS_USER=alice \
FRESHRSS_API_PASSWORD=... \
npx -y @ni-c/freshrss-mcp
```

It speaks [MCP](https://modelcontextprotocol.io) over stdio, so on its own it just
waits on stdin — that is correct behaviour. Point a client at it next.

::: tip It starts without credentials on purpose
With nothing configured the server still completes the handshake and lists all its
tools; every call then fails with these setup instructions. That is what lets
registry sandboxes and the MCP Inspector enumerate the tools without an account.
:::

## 4. First calls

Ask your client for `get_user_info` — it is the cheapest credential check and
returns the FreshRSS account you are authenticated as. Then `list_feeds`, which
gives you the numeric `feedId` values every other tool takes as `feed_id`.

## Next

- [Connecting clients](/guide/clients)
- [Configuration](/guide/configuration)
