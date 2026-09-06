# Remote Access Setup

Use this when you want to open Vulcan from another device (phone, tablet, another laptop).

## CLI ↔ Env option map

The Vulcan CLI accepts the following configuration options, available either as CLI flags or environment variables:

| CLI flag                | Env var               | Notes                              |
| ----------------------- | --------------------- | ---------------------------------- |
| `--mode <web\|desktop>` | `VULCAN_MODE`         | Runtime mode.                      |
| `--port <number>`       | `VULCAN_PORT`         | HTTP/WebSocket port.               |
| `--host <address>`      | `VULCAN_HOST`         | Bind interface/address.            |
| `--home-dir <path>`     | `VULCAN_HOME`         | Base directory.                    |
| `--dev-url <url>`       | `VITE_DEV_SERVER_URL` | Dev web URL redirect/proxy target. |
| `--no-browser`          | `VULCAN_NO_BROWSER`   | Disable auto-open browser.         |
| `--auth-token <token>`  | `VULCAN_AUTH_TOKEN`   | WebSocket auth token.              |

> TIP: Use the `--help` flag to see all available options and their descriptions.

## Security First

- Always set `--auth-token` before exposing the server outside localhost.
- Treat the token like a password.
- Prefer binding to trusted interfaces (LAN IP or Tailnet IP) instead of opening all interfaces unless needed.

## 1) Build + run server for remote access

Remote access should use the built web app (not local Vite redirect mode).

```bash
bun run build
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host 0.0.0.0 --port 3773 --auth-token "$TOKEN" --no-browser
```

Then open on your phone:

`http://<your-machine-ip>:3773`

Example:

`http://192.168.1.42:3773`

Notes:

- `--host 0.0.0.0` listens on all IPv4 interfaces.
- `--no-browser` prevents local auto-open, which is usually better for headless/remote sessions.
- Ensure your OS firewall allows inbound TCP on the selected port.

## 2) Tailnet / Tailscale access

If you use Tailscale, you can bind directly to your Tailnet address.

```bash
TAILNET_IP="$(tailscale ip -4)"
TOKEN="$(openssl rand -hex 24)"
bun run --cwd apps/server start -- --host "$(tailscale ip -4)" --port 3773 --auth-token "$TOKEN" --no-browser
```

Open from any device in your tailnet:

`http://<tailnet-ip>:3773`

You can also bind `--host 0.0.0.0` and connect through the Tailnet IP, but binding directly to the Tailnet IP limits exposure.

## Persistent bot host

Run the Vulcan server and scheduler on the selected machine; a browser connection
is only the client. An SSH tunnel to a process running on a laptop does not move
bot execution or make it persistent.

For a Linux host with an installed, built package, run:

```bash
bash scripts/install-bot-host.sh /absolute/path/to/installed-package vulcan-bots 3774
```

The installer creates a separate user service, a private state directory and
an authentication token. It refuses to overwrite an existing service. Enable
user lingering for logout persistence, and expose the loopback port with a
**tailnet-only HTTPS** Tailscale Serve listener. Set `VULCAN_PUBLIC_URL` in the
service's private environment file to that HTTPS address to issue pairing links.
Do not enable Funnel for this host.

Open **New agent** and describe its job in chat. Roles are saved configuration;
there are no project-specific bot implementations. The bot can inspect its real
host and update its own profile through scoped tools. Existing normal chat
model controls and automation tools remain available.

Optional integrations are host configuration, not bot code:

- `VULCAN_AGENT_BROWSER_BIN`: absolute path to an installed `agent-browser`
  executable. `AGENT_BROWSER_EXECUTABLE_PATH` may select an installed Chrome.
  Server-browser tools use each bot's own persistent profile directory.
- `AGENTMAIL_API_KEY`: configure privately on the host, never in a chat message
  or bot memory. Bots can request their own inbox, read it, draft, and send
  authorized drafts. Inbox IDs are bound to the calling bot on the server.

The service restarts after process failure; schedules and saved memory persist.
This does not guarantee an uninterrupted in-flight model turn after a machine
restart. Reconcile uncertain external actions before retrying them.
