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

Create `.env` in the `internal-service/` folder (it's gitignored, so
`git pull` never touches it). You'll fill in the two `ACCESS_*` values in
step 3:

```bash
cd ~/mcp-for-ssh-control/internal-service
tee .env > /dev/null <<'EOF'
ACCESS_CLIENT_ID=REPLACE_ME.access
ACCESS_CLIENT_SECRET=REPLACE_ME
# The exact docker container names you allow, comma-separated
# (get them with: docker ps --format '{{.Names}}' | paste -sd, -)
ALLOWED_CONTAINERS=wordpress,wordpress-db,odoo,odoo-db,wanderer,crm
ALLOWED_SERVICES=nginx,docker,cloudflared
PORT=8787
EOF
chmod 600 .env
```

Then run it — two options depending on whether you have root:

**Without sudo (user-level, e.g. a shared/managed host):** use pm2 with the
bundled `start.sh` wrapper, which loads `.env` and starts the server:

```bash
npm install -g pm2   # if this needs root: npm config set prefix ~/.local
                     # and add ~/.local/bin to PATH first
pm2 start ./start.sh --name lightsail-mcp-internal
```

Prerequisite check: run `docker ps` as your user. If it's denied, you're not
in the `docker` group and the `docker_*` tools can't work until a host admin
adds you (`systemctl status` and the disk/memory/uptime tools are unaffected
— reading service status doesn't need privileges).

**With sudo (only if you want systemd instead of pm2):** the repo ships
`internal-service/lightsail-mcp-internal.service.example` as a template for
this path — it is **optional** and unused by the pm2 route above, so if you
went the no-sudo way you can ignore that file entirely. To use it: copy it to
`/etc/systemd/system/lightsail-mcp-internal.service`, edit the `User=` and
`WorkingDirectory=`/`EnvironmentFile=` paths to match your box, then
`sudo systemctl daemon-reload && sudo systemctl enable --now lightsail-mcp-internal`.
Pick pm2 **or** systemd — not both, or two copies will fight over port 8787.

Either way, the service refuses to start without the `ACCESS_*` vars, and
only ever listens on `127.0.0.1`.

**Verify it** with the smoke test (checks that bad credentials get 401 and
non-allowlisted names get rejected):

```bash
ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... ./smoke-test.sh
```

### 2. Cloudflare Tunnel

cloudflared is a single static binary, so no package manager or root is
needed — download it into `~/bin`:

```bash
mkdir -p ~/bin
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/bin/cloudflared
chmod +x ~/bin/cloudflared
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

cloudflared tunnel login
cloudflared tunnel create lightsail-mcp
```

Create `~/.cloudflared/config.yml` (everything cloudflared needs lives in
`~/.cloudflared/`, no root required):

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<youruser>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: lightsail-internal.<yourdomain>.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns lightsail-mcp lightsail-internal.<yourdomain>.com
```

Then run the tunnel. Without sudo, keep it under pm2 alongside the internal
service; with sudo, `sudo cloudflared service install` installs it under
systemd instead:

```bash
pm2 start "cloudflared tunnel run lightsail-mcp" --name cloudflared
```

**Surviving reboots (user-level):** `pm2 startup` normally wants root, so
use a user crontab instead — it restores both pm2 processes on boot:

```bash
pm2 save
( crontab -l 2>/dev/null; echo "@reboot $(which pm2) resurrect" ) | crontab -
```

No firewall changes either way — the tunnel is an outbound connection.

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
edge, and the internal service re-checks it again on the box. Put the real
token values into `internal-service/.env`, restart the service
(`pm2 restart lightsail-mcp-internal`, or `sudo systemctl restart
lightsail-mcp-internal` on the systemd path), and re-run the smoke test
against the public hostname to confirm the whole path:

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

### 5. Deploy the Worker (dashboard only — no wrangler CLI needed)

Everything is done from the Cloudflare dashboard. Cloudflare builds the
Worker from your repo on every push (Workers Builds), running
`npx wrangler deploy` for you — you never run wrangler locally.

#### How `wrangler.toml` fits in

`worker/wrangler.toml` is committed to the repo and is the **source of truth
for the Worker's shape**. On each deploy Cloudflare reads it and reconciles
the live Worker to match. That split matters:

| Lives in `wrangler.toml` (committed) | Lives in the dashboard (never committed) |
|---|---|
| Worker name, `main`, compatibility flags | Plain-text variables (`ALLOWED_GITHUB_USER`, `INTERNAL_SERVICE_URL`) |
| Durable Object binding + migration (`MCP_OBJECT`) | Secrets (`GITHUB_*`, `ACCESS_*`, `COOKIE_ENCRYPTION_KEY`) |
| KV binding name + **namespace id** (`OAUTH_KV`) | — |

Two rules follow from this, and they are opposites — which is the part that
trips people up:

- **Bindings** (KV, Durable Objects) *must* be in `wrangler.toml`. If you add
  a binding only through the dashboard UI, the next push-triggered deploy
  **deletes it**, because the config file didn't mention it. This is why the
  KV namespace id has to be written into the file (step 2 below).
- **Variables and secrets** are the opposite. `keep_vars = true` (already set
  in the file) tells wrangler *not* to wipe dashboard-managed variables on
  deploy. So you set all of those in the UI once and they survive every
  future deploy — and nothing sensitive ever lands in the repo.

You will only ever edit `wrangler.toml` for one thing during setup: pasting
the KV namespace id. Everything else in it is already correct.

Then, in order:

1. **Create the KV namespace**: dashboard → Storage & Databases → KV →
   Create namespace (name it e.g. `lightsail-mcp-oauth`). Copy its
   **Namespace ID** (a 32-char hex string).
2. **Put the id into `wrangler.toml`** — pick one:
   - *Commit it (simplest)*: edit `worker/wrangler.toml`, replace
     `<REPLACE_WITH_KV_NAMESPACE_ID>` under `[[kv_namespaces]]` with the id,
     and commit — the GitHub web editor is fine. The id is an identifier,
     not a secret: it's useless without authenticated access to your
     Cloudflare account, so it's safe in a public repo (Cloudflare's own
     templates commit KV ids).
   - *Keep it out of the repo*: leave the placeholder in the file and
     substitute it at build time. In the Worker's build settings
     (Settings → Build → Build command) put
     `sed -i "s|<REPLACE_WITH_KV_NAMESPACE_ID>|$OAUTH_KV_NAMESPACE_ID|" wrangler.toml`
     and add a **build variable** (Settings → Build) named
     `OAUTH_KV_NAMESPACE_ID` set to the id. (`wrangler.toml` can't read env
     vars itself; the `sed` rewrites the file just before `wrangler deploy`
     runs. Note this is a *build* variable, distinct from the runtime
     Variables and Secrets in step 4.)
3. **Connect the repo**: Workers & Pages → Create → Workers → Import a
   repository → pick this repo, and set **Root Directory = `worker`** (under
   Advanced / Build configuration). Leave the build command empty and the
   deploy command as the default `npx wrangler deploy`. This first build
   creates the Worker, the KV binding, and the Durable Object migration.
   Uncheck "Builds for non-production branches" unless you want preview
   deploys on every branch.
4. **Set the runtime variables and secrets**: Worker → Settings → Variables
   and Secrets (these are what `keep_vars` preserves):
   - Plain text: `ALLOWED_GITHUB_USER` = your GitHub username;
     `INTERNAL_SERVICE_URL` = `https://lightsail-internal.<yourdomain>.com`
     — the scheme **must be `https://`**, not `http://` (plain http won't
     route through the tunnel and the tool calls 404).
   - Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (step 4 above),
     `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET` (step 3, the same values as
     the box's `.env`), and `COOKIE_ENCRYPTION_KEY` (any long random string,
     e.g. `openssl rand -hex 32`). Paste secrets carefully — a trailing
     space or newline makes the token silently mismatch.

   Until all seven are set, the Worker replies with a message listing
   exactly which ones are missing rather than failing cryptically.
5. **Redeploy** so the new variables take effect (Deployments → retry latest,
   or push any commit). Dashboard variable changes only apply to *new*
   deployments.
6. **Custom domain**: Worker → Settings → Domains & Routes → Add →
   Custom domain → `mcp-ssh.<yourdomain>.com`. This must match the domain in
   your GitHub OAuth app's callback URL (step 4).

> **When you change `wrangler.toml` later** (e.g. a new binding), just commit
> and push — Workers Builds redeploys automatically. **When you change a
> variable or secret**, edit it in the dashboard and redeploy; don't put it
> in `wrangler.toml`.

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
