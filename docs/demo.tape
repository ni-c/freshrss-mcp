# vhs script for the demo GIF: `vhs docs/demo.tape` writes public/demo.gif
#
# Prerequisites:
#   * vhs installed (https://github.com/charmbracelet/vhs)
#   * the server built (npm run build)
#   * a reachable FreshRSS instance with the API enabled and an API password set
#   * ~/.config/freshrss-mcp.env (chmod 600, OUTSIDE the repo) holding
#     FRESHRSS_URL, FRESHRSS_USER and FRESHRSS_API_PASSWORD as KEY=value lines.
#     It is sourced inside a Hide block, so no credential is typed on screen.
#   * run from the repository root, not from docs/
#
# A throwaway instance is enough and is what this was recorded against:
#   docker run -d --name freshrss-demo -p 8013:80 freshrss/freshrss:1.29.1-alpine
#   docker exec freshrss-demo php /var/www/FreshRSS/cli/do-install.php \
#     --default-user=demo --auth-type=form --api-enabled --db-type=sqlite
#   docker exec freshrss-demo php /var/www/FreshRSS/cli/create-user.php \
#     --user demo --password "$PW" --api-password "$APW"
#   docker exec freshrss-demo php /var/www/FreshRSS/cli/actualize-user.php --user demo
#
# Only read-only tools are recorded on purpose.
#
# Two traps, both of which produced a full recording of nothing but errors before
# they were understood:
#
#   1. Exporting the variables in your own shell is NOT enough, twice over. vhs
#      starts its own shell and does not inherit them — hence the sourcing below.
#      And even then the MCP Inspector does not forward them: the SDK's stdio
#      transport passes only an allowlisted environment (PATH, HOME, …) to the
#      server it spawns, so FRESHRSS_* must be handed over with explicit `-e`
#      flags. The wrapper function does that; the shell expands the values, so the
#      terminal only ever shows the variable names.
#   2. `-e` must come AFTER the server command, not before it: `--cli -e K=V node
#      dist/index.js` makes the inspector lose the target and report "No servers
#      found in config file".
#
# Inside a Hide block use vhs's own `Sleep`, never the shell's — a shell sleep
# blocks and the tape ends before any output is recorded. The first typed line can
# also be swallowed while the shell is still starting, so a throwaway `clear` goes
# first and the sourcing second; the guard makes a silent failure loud.

Output docs/public/demo.gif

Set FontSize 16
Set Width 1200
Set Height 700
Set Padding 20
Set Theme "Catppuccin Mocha"

Hide
Sleep 1s
Type "clear" Enter
Sleep 500ms
Type "set -a; . ~/.config/freshrss-mcp.env; set +a" Enter
Sleep 500ms
Type 'test -n "$FRESHRSS_API_PASSWORD" || echo "ENV NOT LOADED — see the tape header"' Enter
Sleep 500ms
Type 'mcp() { npx -y @modelcontextprotocol/inspector --cli node dist/index.js -e "FRESHRSS_URL=$FRESHRSS_URL" -e "FRESHRSS_USER=$FRESHRSS_USER" -e "FRESHRSS_API_PASSWORD=$FRESHRSS_API_PASSWORD" "$@"; }' Enter
Sleep 500ms
Type "clear" Enter
Sleep 500ms
Show

Type "# mcp() = the MCP Inspector CLI against ./dist/index.js, credentials via -e" Enter
Sleep 2s
Type "# 1. what does the server expose?" Enter
Sleep 1s
Type "mcp --method tools/list | jq -r '.tools[].name' | column" Enter
Sleep 8s
Type "# 2. what am I subscribed to?" Enter
Sleep 1500ms
Type "mcp --method tools/call --tool-name list_feeds | jq -r '.content[0].text'" Enter
Sleep 9s
Type "# 3. the newest article, as plain text" Enter
Sleep 1500ms
Type "mcp --method tools/call --tool-name list_articles --tool-arg limit=1 | jq -r '.content[0].text' | head -20" Enter
Sleep 10s
