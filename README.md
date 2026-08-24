# Server Control via MCP Portal

Manage one or more servers — Docker containers, disk/memory checks, service
status, file editing, and script diagnosis — from Claude (mobile app,
claude.ai, or Claude Code), **with no inbound ports opened on the servers**.

Each box runs a small MCP server bound to loopback and reachable only through
a Cloudflare Tunnel. A [Cloudflare MCP server portal][portal-docs] aggregates
them behind one URL and one login, and that URL is what you add to Claude.

[portal-docs]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/

---

## v2 is a clean break

v1 put a Cloudflare Worker in the middle: it implemented the MCP protocol,
ran its own GitHub OAuth flow against a single-user allowlist, and forwarded
each call to a private `POST /run` JSON API on the box. Cloudflare's MCP
portals now do the aggregation and the authentication, so the Worker is gone
and the box speaks MCP directly.

**v2 is not compatible with a v1 install and does not try to be.** The
Worker, its OAuth app, its KV namespace, and the `/run` endpoint no longer
exist. Install from scratch, then [tear down the v1 pieces](#retiring-a-v1-install).

| | v1 | v2 |
|---|---|---|
| MCP implementation | Cloudflare Worker | on the box |
| Authentication | GitHub OAuth app + single-user allowlist, implemented in the Worker | Cloudflare Access policy on the portal |
| Multiple servers | one Worker fanning out, `server` argument on every tool | portal aggregates, tools namespaced `{server_id}_{tool}` |
| Box API | private `POST /run {command, args}` | MCP Streamable HTTP at `POST /mcp` |
| Code to maintain | ~1,150 lines of Worker + ~580 on the box | ~950 on the box |
| Deploy pipeline | Workers Builds on every push | `git pull` + restart |

## Architecture

```
Claude (any client)
   │
   │  HTTPS + OAuth via Cloudflare Access
   ▼
Cloudflare MCP server portal (mcp.<yourdomain>.com)
   - One Access policy decides who may connect at all
   - Aggregates every box, namespacing tools as {server_id}_{tool_name}
   - Logs every tool call: who, what, when
   │
   │  attaches each box's Access service token as request headers
   ▼
Cloudflare Access (validates the service token at the edge)
   │
   ▼
Cloudflare Tunnel (outbound-only from each box — no inbound ports)
   │
   ▼
MCP server on the box (127.0.0.1:8787/mcp)
   - Re-validates the service token itself
   - Executes ONLY the tools defined in src/tools.js, never arbitrary shell
   - Container/service names checked against explicit allowlists
   - File and script tools jailed to ALLOWED_PATHS

                      ┌→ tunnel → box "lightsail"   (its own allowlists)
   one portal ────────┼→ tunnel → box "aws-docker"  (its own allowlists)
                      └→ tunnel → box "web"         (its own allowlists)
```

## Security properties

- **No new inbound ports.** `cloudflared` dials out; the server firewall never
  changes. The MCP server binds `127.0.0.1` and the bind address is not
  configurable.
- **Two auth layers on the tunnel.** Cloudflare Access validates the service
  token at the edge, and the MCP server re-checks it on the box with a
  timing-safe comparison. Access consumes the `CF-Access-Client-*` headers,
  so the portal is configured to send a second copy as `X-Internal-Client-*`
  that survives the hop — a misconfigured Access application still cannot
  expose an unauthenticated box.
- **No arbitrary shell, ever.** Every command is built as an argv array and
  run with `execFile` and `shell: false`. There is no string interpolation
  into a command line anywhere in this codebase, and no tool accepts one.
- **Names are allowlisted.** Container and unit names must match a strict
  shape *and* appear in `ALLOWED_CONTAINERS` / `ALLOWED_SERVICES`. The shape
  check is a second line of defense: even an allowlist typo cannot smuggle an
  option-like argument such as `--privileged`. Either list may be set to a
  lone `*` to accept every name on the box; the shape check still applies,
  and the set of *operations* is unchanged either way.
- **File and script tools are jailed to `ALLOWED_PATHS`.** Every path is
  resolved with `realpath`, so `..` segments and symlinks planted inside a
  root cannot escape it. Unset `ALLOWED_PATHS` and all six tools are disabled.
  `run_script` never invokes an arbitrary binary — it runs a script *file*
  from inside the roots through a fixed interpreter set (bash/sh/python3/node,
  chosen by shebang or extension).
  The honest caveat: write access plus run access inside the same root is
  code execution as the service user. Only list directories you are
  comfortable with a model editing and executing in.
- **Container creation goes through a file, not a flag.** The
  `docker_compose_*` tools take a path to a compose file and nothing else —
  no image, port, mount, or capability is ever read from a tool argument.
  They are jailed to `ALLOWED_COMPOSE_PATHS`, a list kept separate from
  `ALLOWED_PATHS` precisely so that enabling them is a deliberate act. Read
  [Creating containers](#creating-containers) before setting it: a compose
  file is a more powerful thing to control than a shell script.
- **One Access policy controls access.** Where v1 hardcoded a single GitHub
  username, v2 uses an Access policy — your email, your IdP group, plus
  device posture or country rules if you want them.
- **Every call is logged.** Zero Trust > Access controls > AI controls shows
  which identity called which tool on which server, and when.
- **No secrets in the repo.** Credentials live in a gitignored `.env` on each
  box and in Cloudflare, which stores them encrypted.

## Repo layout

```
mcp-server/                 — runs on each box; this is the whole product
  src/index.js                — HTTP entrypoint, Streamable HTTP transport
  src/config.js               — environment parsing and validation
  src/auth.js                 — service-token check (timing-safe)
  src/sandbox.js              — allowlists, path jail, argv execution
  src/tools.js                — the 14 tool definitions
  smoke-test.sh               — verifies auth, handshake, and that the
                                allowlists actually reject
  mcp-server.service.example  — systemd unit template
  .env.example
```

---

## Deployment

You need a Cloudflare account with your domain on it, an
[identity provider configured in Zero Trust][idp], and SSH access to each box
for setup only.

[idp]: https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/

Steps 1–3 are per box. Steps 4–6 are once.

### 1. Install the MCP server on the box

```bash
git clone https://github.com/cobiadigital/mcp-for-ssh-control.git
cd mcp-for-ssh-control/mcp-server
npm install
cp .env.example .env
chmod 600 .env
$EDITOR .env    # SERVER_ID and the allowlists now; ACCESS_* in step 3
```

`SERVER_ID` is a label for this box. It shows up in the service's log lines,
in `server_info` output, and as the MCP server's advertised name — it is how
you tell one box's output from another's when reading logs. It does not
affect how Claude addresses the tools; that is set on the Cloudflare side in
[step 4](#4-register-each-box-as-an-mcp-server-in-access), and it is conventional to
use the same word in both places.

Prerequisite check: run `docker ps` as the service user. If it is denied you
are not in the `docker` group and the `docker_*` tools will not work until an
admin adds you. The disk, memory, uptime, and `systemctl status` tools are
unaffected.

Run it as a service:

```bash
sudo cp mcp-server.service.example /etc/systemd/system/mcp-server.service
sudo $EDITOR /etc/systemd/system/mcp-server.service   # User, WorkingDirectory, EnvironmentFile
sudo systemctl daemon-reload
sudo systemctl enable --now mcp-server
```

Without root, pm2 works equally well:

```bash
pm2 start "node src/index.js" --name mcp-server --update-env
pm2 save
( crontab -l 2>/dev/null; echo "@reboot $(which pm2) resurrect" ) | crontab -
```

The service refuses to start without `ACCESS_CLIENT_ID` and
`ACCESS_CLIENT_SECRET`, so you will come back to this after step 3.

### 2. Cloudflare Tunnel

`cloudflared` is a single static binary — no package manager or root needed:

```bash
mkdir -p ~/bin
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o ~/bin/cloudflared
chmod +x ~/bin/cloudflared
echo 'export PATH="$HOME/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc

cloudflared tunnel login
cloudflared tunnel create lightsail-mcp
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /home/<youruser>/.cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: lightsail-mcp.<yourdomain>.com
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
cloudflared tunnel route dns lightsail-mcp lightsail-mcp.<yourdomain>.com
sudo cloudflared service install        # or: pm2 start "cloudflared tunnel run lightsail-mcp" --name cloudflared
```

No firewall changes — the tunnel is an outbound connection. Confirm the DNS
record Cloudflare created for the hostname has **Proxy status: Proxied**.

### 3. Access service token and application

In **Zero Trust > Access controls**:

1. **Service credentials > Create service token.** Name it after the box.
   Copy the Client ID and Client Secret — the secret is shown once. This is
   the only credential that reaches the box.
2. **Applications > Add > Self-hosted.** Domain =
   `lightsail-mcp.<yourdomain>.com`. Add one policy with action
   **Service Auth** (not Allow) that includes that service token.

Now put the token into the box's `.env` and restart:

```bash
$EDITOR ~/mcp-for-ssh-control/mcp-server/.env   # ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET
sudo systemctl restart mcp-server               # or: pm2 restart mcp-server --update-env
./smoke-test.sh
```

The smoke test runs against loopback on purpose — it bypasses the tunnel, so
a failure is unambiguously the service's fault rather than the network's. All
12 checks should pass before you go on.

### 4. Register each box as an MCP server in Access

This is the step that replaces the entire Worker. The portal reaches each box
by sending the box's service token as request headers.

Cloudflare stores those headers as the server's `auth_credentials`, which the
[API documents][auth-docs] as a JSON string whose headers are forwarded
verbatim upstream. Send **both** header pairs: Access validates and consumes
the `CF-Access-*` pair at the edge, and the `X-Internal-*` pair passes through
for the box's own re-check.

[auth-docs]: https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/mcp-portals/#bearer-authentication-credentials

```bash
curl "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/access/ai-controls/mcp/servers" \
  --request POST \
  --header "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  --json '{
    "name": "lightsail",
    "server_id": "lightsail",
    "hostname": "https://lightsail-mcp.<yourdomain>.com/mcp",
    "auth_type": "bearer",
    "auth_credentials": "{\"headers\":{\"CF-Access-Client-Id\":\"<token-id>.access\",\"CF-Access-Client-Secret\":\"<token-secret>\",\"X-Internal-Client-Id\":\"<token-id>.access\",\"X-Internal-Client-Secret\":\"<token-secret>\"}}"
  }'
```

Notes that matter:

- The URL **must** end in `/mcp`. The portal treats that as "Streamable HTTP
  only" and skips its SSE fallback probing.
- **`server_id` must not contain underscores** — use hyphens
  (`aws-docker`, not `aws_docker`). See [How tool names are
  built](#how-tool-names-are-built) below for why.
- The same values are editable in the dashboard afterwards under **AI
  controls > MCP servers >** the server **> Authentication**.

Then attach an Access policy to the server (**AI controls > MCP servers >
Edit > Policies**) allowing your own identity. A server with no policy is
invisible in every portal.

Repeat for each box. The server status should reach **Ready**, meaning
Cloudflare connected and read the tool list.

#### How tool names are built

The portal merges the tools from every box into one flat list. All three
boxes expose a tool called `docker_ps`, so the portal prefixes each one with
that box's `server_id` to keep them apart:

```
box "lightsail"   →  lightsail_docker_ps
box "aws-docker"  →  aws-docker_docker_ps
```

When Claude calls `lightsail_docker_ps`, the portal reverses that to decide
where to forward the call. It splits **on the first underscore only** —
everything before it is the server id, everything after it is the tool name:

```
lightsail_docker_ps   →  server "lightsail"  +  tool "docker_ps"     ✓
```

Tool names can therefore contain underscores freely, since only the first one
is a delimiter. A `server_id` cannot, because its underscore would be read as
the delimiter instead:

```
aws_docker_docker_ps  →  server "aws"  +  tool "docker_docker_ps"    ✗
```

Neither of those exists, so every tool on that box fails. Keep server ids
short and hyphenated.

### 5. Create the portal

**AI controls > Portals > Create a portal.** Give it a hostname such as
`mcp.<yourdomain>.com`, add every server, and attach an Access policy for
your own identity — this is the policy that replaces v1's single-user GitHub
allowlist, and it is the only thing standing between the internet and your
boxes, so scope it to you specifically.

For each server in the portal, leave **Require user auth** off. It only
applies to servers using per-user upstream OAuth; these use a service token.

Creating the portal in the dashboard also creates the CNAME to
`gateway.agents.cloudflare.com`. If you use the API or Terraform instead,
create that record yourself and make sure it is proxied — a missing record
is the usual cause of a `522`.

### 6. Connect Claude

Add `https://mcp.<yourdomain>.com/mcp` as a custom connector. Claude opens
the Access login in a browser, you authenticate with your IdP, and the tools
appear namespaced per box.

---

## Tools

Every tool acts on the box whose namespace it carries — there is no `server`
argument in v2.

| Tool | Notes |
|---|---|
| `server_info` | Hostname, allowlists, and path roots. Best first call on an unfamiliar box. |
| `docker_ps` | All containers with status and ports. |
| `docker_logs` | Allowlisted container; `lines` defaults to 50, max 1000. |
| `docker_restart` | Allowlisted container. |
| `docker_compose_up` | Creates and starts a stack from a compose file (`up -d`). Optional `services`, `recreate`. |
| `docker_compose_down` | Stops and removes a stack's containers. Never passes `--volumes`, so data survives. |
| `docker_compose_pull` | Pulls a stack's images without starting anything. |
| `docker_compose_ps` | The stack's containers and their state. |
| `disk_usage` / `memory_usage` / `uptime` | `df -h`, `free -h`, `uptime`. |
| `service_status` | Allowlisted systemd unit. |
| `list_directory` | Type, size, mtime, name. Caps at 500 entries. |
| `read_file` | Truncates past 512 KB. |
| `write_file` | Parent directory must already exist. |
| `edit_file` | Exact string replacement; `old_string` must be unique unless `replace_all`. |
| `check_script` | `bash -n` / `sh -n` (plus shellcheck when installed), `py_compile`, `node --check`. Never runs the script. |
| `run_script` | bash/sh/python3/node only, ≤16 args, timeout 1–120s (default 30). |

The six file and script tools require `ALLOWED_PATHS` and refuse anything
outside those roots. The four `docker_compose_*` tools require
`ALLOWED_COMPOSE_PATHS`, which is a separate list — see [Creating
containers](#creating-containers).

## Creating containers

New containers are created from a compose file on disk, not from a
`docker run` tool. The workflow is:

1. Claude writes or edits a `docker-compose.yml` with `write_file` /
   `edit_file` — a change you can read, diff, and keep in git.
2. `docker_compose_up` brings it up.

Set the roots that permits, in the service's `.env`:

```bash
ALLOWED_COMPOSE_PATHS=/home/ubuntu/stacks
```

Leave it unset and all four compose tools are disabled and say so when
called.

### Why this is a separate setting from ALLOWED_PATHS

Because a compose file is not just another file. It can ask for
`privileged: true`, or bind-mount `/` into a container, or add
`CAP_SYS_ADMIN` — and the Docker daemon runs as root. So anything that can
both **write** a compose file and **bring it up** can become root on the box,
even though nothing in this codebase ever runs a shell.

That is a real escalation over the script tools, where the blast radius stops
at the service user. Keeping the two root lists separate means you can grant
the safer one widely and the sharper one narrowly:

```bash
# Claude may edit anything under here, but cannot deploy from it
ALLOWED_PATHS=/home/ubuntu/scripts,/home/ubuntu/sites,/home/ubuntu/stacks
# ...and may only bring stacks up from here
ALLOWED_COMPOSE_PATHS=/home/ubuntu/stacks
```

The strictest arrangement is to leave the compose roots *out* of
`ALLOWED_PATHS` entirely. Then Claude can deploy the compose files you wrote
but cannot rewrite them first, and the escalation above is closed. Pick that
one if you want the tools to operate stacks rather than author them.

### What the tools deliberately cannot do

- **No `--volumes` on down.** `docker_compose_down` removes containers and
  leaves named volumes alone, so a tool call cannot destroy a database.
  Removing volumes stays an SSH job.
- **No image or flag from a tool argument.** Everything comes from the file.
  The only other argument is an optional list of service names, shape-checked
  so it cannot be read as an option.
- **No compose file outside the roots**, and the path must end in `.yml` or
  `.yaml`.

## Adding a server later

Repeat steps 1–4 on the new box, then add it to the portal under **AI
controls > Portals > Edit > Servers**. Nothing on the existing boxes changes,
and nothing needs redeploying — which is the main practical win over v1,
where fleet configuration lived in the Worker's environment.

## Retiring a v1 install

Once the portal works, delete the v1 pieces — several of them are live
credentials:

1. Delete the `lightsail-mcp` Worker (and any per-server copy of it).
2. Delete its KV namespace.
3. Delete the GitHub OAuth app that fronted it.
4. Remove the Workers Builds connection to this repo.
5. Remove the old `mcp-ssh.<yourdomain>.com` DNS record.
6. Remove the connector pointing at the old Worker from Claude.
7. On each box, stop and disable the old service
   (`lightsail-mcp-internal`), then delete the old checkout.

Rotate the Access service tokens while you are there — v1 shared them with
the Worker, and only the boxes and the portal need them now.

## Troubleshooting

**The service will not start: `status=203/EXEC`.** systemd could not find
Node at the path in `ExecStart`. The shipped unit uses `/usr/bin/env node`,
which searches systemd's default service PATH and so covers both
`/usr/bin/node` and `/usr/local/bin/node`. If your Node lives outside that
PATH — nvm installs under `~/.nvm`, and a `User=` service gets the *system*
PATH, not that user's login PATH — put the absolute path from
`command -v node` into `ExecStart` instead. On a box with more than one Node,
check which one actually got used: `systemctl show -p ExecStart mcp-server`.

**Server status is `Error` or `unreachable`.** Cloudflare cannot reach the
box. Check in order: the tunnel is running (`cloudflared` in `systemctl` or
`pm2 list`), the service is running (`systemctl status mcp-server`), the DNS
record is proxied, and the registered URL ends in `/mcp`. Hovering the status
in the dashboard shows the HTTP status Cloudflare actually got.

**Server status is `Error` with HTTP 403 and an HTML body titled
`Error ・ Cloudflare Access`.** The request never reached the box — Access
blocked it at the edge and served its login page, which a machine client sees
as a 403. This server only ever answers JSON, so an HTML body is proof the
edge answered rather than the origin.

The cause is the Access application on the *tunnel hostname*, which is a
different object from the MCP server entry in AI controls. Open **Access >
Applications >** that hostname **> Policies** and add one with **Action:
Service Auth** and **Include: Service Token >** your token. It must be
*Service Auth*: an *Allow* policy still expects an identity and redirects a
non-browser client to the IdP, producing exactly this page. Then **Sync
capabilities** on the server.

Note that registering an MCP server creates its own Access application of
type *mcp*. If the hostname already had a self-hosted Access application, two
now cover it — filter Applications by hostname and confirm which is matching.

**Server status is `Error` with HTTP 401.** This one *did* reach the box: the
401 is this server's own check, returned as JSON. The headers in
`auth_credentials` do not match the box's `.env`. Note that a service token's
client id ends in `.access` — a truncated copy is the usual culprit. Also
confirm all four headers are present: Access consumes the `CF-Access-*` pair
at the edge, so the origin only ever sees the `X-Internal-*` copy, and sending
only the former gets you past Access and then straight into a 401.

To tell the two apart without the dashboard, send the portal's exact request
yourself:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://<hostname>/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H 'CF-Access-Client-Id: <id>.access' \
  -H 'CF-Access-Client-Secret: <secret>' \
  -H 'X-Internal-Client-Id: <id>.access' \
  -H 'X-Internal-Client-Secret: <secret>' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**`No allowed servers available, check your Zero Trust Policies`.** The
portal has a policy but a server does not, or the server is not `Ready`.
Every server needs its own Access policy.

**The portal returns 522.** The CNAME to `gateway.agents.cloudflare.com` is
missing or not proxied. The dashboard creates it; the API and Terraform do not.

**Tools are missing after you changed them.** Cloudflare caches each server's
tool list. Use **AI controls > MCP servers >** three dots **> Sync
capabilities** after restarting the box's service.

**A tool says something is not on the allowlist.** That is the design
working. Add the name to `ALLOWED_CONTAINERS` / `ALLOWED_SERVICES` /
`ALLOWED_PATHS` in the box's `.env` and restart the service.

## Requirements

- A domain on Cloudflare, on a full or partial (CNAME) setup
- An identity provider configured in Cloudflare Zero Trust
- Node.js 20+ on each box
- MCP server portals are in open beta; portal logs export via Logpush is
  Enterprise-only, but the in-dashboard logs are not
