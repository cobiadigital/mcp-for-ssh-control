# Lightsail Server Control via Remote MCP

Manage a Lightsail server — Docker containers, disk/memory checks, service
status — from Claude (mobile app, claude.ai, or Claude Code) as a custom MCP
connector, **with no inbound ports opened on the server**.

## Architecture

```
Claude (any client)
   → HTTPS → Cloudflare Worker (mcp-ssh.<yourdomain>.com)
        - Auth: GitHub OAuth, restricted to ONE allowlisted GitHub username
        - Implements the MCP tools (docker_ps, docker_logs, docker_restart,
          disk_usage, memory_usage, service_status, uptime)
        - Forwards each tool call over HTTPS, authenticated with a
          Cloudflare Access service token
   → Cloudflare Tunnel (outbound-only from the Lightsail box)
   → Internal service on the Lightsail box (127.0.0.1:8787)
        - Re-validates the Access service token on every request
        - Executes ONLY whitelisted commands (never arbitrary shell)
        - Container/service names checked against explicit allowlists
```

Security properties this design preserves:

- **No new inbound ports.** `cloudflared` dials out; the Lightsail firewall
  never changes.
- **Loopback only.** The internal service binds `127.0.0.1` and is reachable
  exclusively through the tunnel.
- **Two auth layers on the tunnel.** Cloudflare Access validates the service
  token at the edge, and the internal service re-checks the
  `CF-Access-Client-Id` / `CF-Access-Client-Secret` headers itself
  (timing-safe compare) — anything else gets a 401.
- **No arbitrary shell, ever.** The internal service has a fixed `COMMANDS`
  map; each command is built as an argv array and run with `execFile`
  (no shell interpretation). Container and service names must pass a shape
  check *and* an explicit allowlist (`ALLOWED_CONTAINERS` /
  `ALLOWED_SERVICES` env vars).
- **Single-user OAuth.** The Worker's GitHub OAuth flow refuses to issue an
  MCP token to any GitHub account except `ALLOWED_GITHUB_USER`.
- **No secrets in the repo.** Everything sensitive goes through
  `wrangler secret put` or an env file on the box.

## Repo layout

```
worker/                — Cloudflare Worker (deploy via Workers Builds or wrangler)
  src/index.ts            — OAuthProvider entrypoint + MCP agent + tool definitions
  src/github-handler.ts   — GitHub OAuth flow with single-user allowlist
  src/workers-oauth-utils.ts — client-approval dialog + signed cookie helpers
  wrangler.toml
internal-service/      — runs on the Lightsail box (deployed manually)
  server.js               — Express app, whitelist-only command execution
  smoke-test.sh           — curl-based auth/whitelist verification
  lightsail-mcp-internal.service.example — systemd unit template
```

If you use Cloudflare **Workers Builds**, set **Root Directory = `worker`**
so pushes only build/deploy that folder. The internal service is deployed by
hand (`git pull` + restart) on the box.

---

## Deployment walkthrough

You'll need: a Cloudflare account with your domain on it, a GitHub account,
and SSH access to the Lightsail box (for setup only — after this you won't
need it for day-to-day checks).

### 1. Internal service on the Lightsail box

```bash
# on the box
git clone https://github.com/cobiadigital/mcp-for-ssh-control.git
cd mcp-for-ssh-control/internal-service
npm install
```

Create `/etc/lightsail-mcp-internal.env` (mode 600, owned by root or the
service user). You'll fill in the two `ACCESS_*` values in step 3:

```bash
ACCESS_CLIENT_ID=<service token client id, ends in .access>
ACCESS_CLIENT_SECRET=<service token client secret>
# The exact docker container names you allow (docker ps --format '{{.Names}}')
ALLOWED_CONTAINERS=wordpress,wordpress-db,odoo,odoo-db,wanderer,crm
ALLOWED_SERVICES=nginx,docker,cloudflared
PORT=8787
```

Run it under systemd (copy
`lightsail-mcp-internal.service.example` to
`/etc/systemd/system/lightsail-mcp-internal.service`, adjust paths/user, then
`sudo systemctl enable --now lightsail-mcp-internal`) — or under pm2:
`pm2 start server.js --name lightsail-mcp-internal` with the env vars set.

The service refuses to start without the `ACCESS_*` vars, and only ever
listens on `127.0.0.1`.

**Verify it** with the smoke test (checks that bad credentials get 401 and
non-allowlisted names get rejected):

```bash
ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... ./smoke-test.sh
```

### 2. Cloudflare Tunnel

```bash
# on the box — install cloudflared, then:
cloudflared tunnel login
cloudflared tunnel create lightsail-mcp
```

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/ubuntu/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: lightsail-internal.<yourdomain>.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns lightsail-mcp lightsail-internal.<yourdomain>.com
sudo cloudflared service install     # runs the tunnel under systemd
```

No firewall changes — the tunnel is an outbound connection.

### 3. Cloudflare Access (service token + policy)

In the Cloudflare dashboard, **Zero Trust → Access**:

1. **Service token**: Access → Service Auth → Create Service Token. Name it
   e.g. `lightsail-mcp`. Copy the Client ID and Client Secret — this is the
   only time the secret is shown. These are the `ACCESS_CLIENT_ID` /
   `ACCESS_CLIENT_SECRET` values for **both** the internal service env file
   (step 1) and the Worker secrets (step 5).
2. **Application**: Access → Applications → Add → Self-hosted. Domain =
   `lightsail-internal.<yourdomain>.com`. Add a policy with action
   **Service Auth** (not Allow) that includes your service token.

Now the tunnel hostname rejects anything without the token at Cloudflare's
edge, and the internal service re-checks it again on the box. Restart the
internal service after putting the real token values in its env file, and
re-run the smoke test against the public hostname to confirm the whole path:

```bash
ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... \
  ./smoke-test.sh https://lightsail-internal.<yourdomain>.com
```

(The two 401 checks will show 302/403 instead when Access blocks at the edge
— either way, bad credentials don't get through.)

### 4. GitHub OAuth app

GitHub → Settings → Developer settings → OAuth Apps → New OAuth App:

- **Homepage URL**: `https://mcp-ssh.<yourdomain>.com`
- **Authorization callback URL**: `https://mcp-ssh.<yourdomain>.com/callback`

Copy the Client ID and generate a Client Secret.

### 5. Deploy the Worker

```bash
cd worker
npm install
npx wrangler kv namespace create OAUTH_KV
# paste the returned id into wrangler.toml ([[kv_namespaces]] id = ...)
```

Edit `wrangler.toml` `[vars]`:

- `ALLOWED_GITHUB_USER` — your GitHub username (the only one allowed in)
- `INTERNAL_SERVICE_URL` — `https://lightsail-internal.<yourdomain>.com`

Set the secrets:

```bash
npx wrangler secret put GITHUB_CLIENT_ID       # from step 4
npx wrangler secret put GITHUB_CLIENT_SECRET   # from step 4
npx wrangler secret put COOKIE_ENCRYPTION_KEY  # openssl rand -hex 32
npx wrangler secret put ACCESS_CLIENT_ID       # from step 3
npx wrangler secret put ACCESS_CLIENT_SECRET   # from step 3
```

Deploy and attach the custom domain:

```bash
npx wrangler deploy
```

Then in the dashboard (Workers & Pages → lightsail-mcp → Settings → Domains
& Routes) add the custom domain `mcp-ssh.<yourdomain>.com`. If you use
Workers Builds instead of CLI deploys, connect the repo with
**Root Directory = `worker`** — secrets and the KV namespace persist across
builds.

### 6. Connect Claude

Add a custom connector pointing at:

```
https://mcp-ssh.<yourdomain>.com/mcp
```

(Claude apps: Settings → Connectors → Add custom connector. Older clients
that only speak SSE can use `/sse` instead.)

On first connect you'll see the approval page, then GitHub login. Any GitHub
account other than `ALLOWED_GITHUB_USER` gets a 403 and no token.

## Tools

| Tool | Arguments | Runs on the box |
|---|---|---|
| `docker_ps` | — | `docker ps -a` (names/status/ports) |
| `docker_logs` | `container`, `lines?` (1–1000) | `docker logs --tail N <name>` |
| `docker_restart` | `container` | `docker restart <name>` |
| `disk_usage` | — | `df -h` |
| `memory_usage` | — | `free -h` |
| `service_status` | `service` | `systemctl status <name> --no-pager` |
| `uptime` | — | `uptime` |

`container` / `service` arguments must be on the box's allowlists.

## Development

```bash
cd worker
npm install
npm run types       # generates worker-configuration.d.ts from wrangler.toml
npm run typecheck
```

`worker-configuration.d.ts` is generated (gitignored) — re-run `npm run types`
whenever `wrangler.toml` bindings change.

## Troubleshooting

- **Tool calls return "Timed out ... waiting for the Lightsail internal
  service"** — the tunnel or the box is down. Check
  `systemctl status cloudflared` and `systemctl status lightsail-mcp-internal`
  on the box. The Worker aborts after 20s rather than hanging.
- **Tool calls return "blocked before reaching the internal service"** — the
  Worker's `ACCESS_CLIENT_ID/SECRET` secrets don't match the Access policy on
  the tunnel hostname. Re-check step 3 and the Worker secrets.
- **"Access denied: GitHub user ... is not authorized"** — you logged into
  GitHub with the wrong account, or `ALLOWED_GITHUB_USER` in `wrangler.toml`
  doesn't match your username.
- **Client stuck at "waiting for authorization"** — usually a wrong GitHub
  callback URL. It must be exactly `https://mcp-ssh.<yourdomain>.com/callback`.
- **`Container "x" is not on the allowlist`** — add the exact name from
  `docker ps --format '{{.Names}}'` to `ALLOWED_CONTAINERS` in the env file
  and restart the internal service.
