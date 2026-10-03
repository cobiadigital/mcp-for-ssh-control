#!/usr/bin/env bash
#
# Box-side installer for Ubuntu. Run it ON the box as the user that should own
# the service (not root; it calls sudo where it needs to):
#
#   cd ~/mcp-for-ssh-control/mcp-server && ./install.sh
#
# It automates everything on this machine and pauses to tell you exactly what
# to click in the Cloudflare dashboard. It never asks for a Cloudflare API
# token: the tunnel is created in the dashboard and this box joins it with the
# tunnel token the dashboard shows you. Safe to re-run; existing .env values
# are offered as defaults.

set -euo pipefail

if [[ $EUID -eq 0 ]]; then
  echo "Run as the normal service user, not root. The script uses sudo itself." >&2
  exit 1
fi
command -v sudo >/dev/null || { echo "sudo is required." >&2; exit 1; }
command -v apt-get >/dev/null || { echo "This installer targets Ubuntu/Debian." >&2; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"
ENV_FILE="$DIR/.env"
SVC_USER="$(id -un)"

say()  { printf '\n\033[1m== %s\033[0m\n' "$1"; }
pause() { read -r -p "$1 [press Enter when done] " _ </dev/tty; }

# Read the current value of KEY from .env, if any.
get_env() { [[ -f $ENV_FILE ]] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

# Set KEY=VALUE in .env, replacing an existing or commented-out line.
# Goes through ENVIRON so backslashes and special characters survive.
set_env() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  K="$key" V="$val" awk '
    BEGIN { k = ENVIRON["K"]; line = k "=" ENVIRON["V"] }
    $0 ~ "^" k "=" || $0 ~ "^# *" k "=" { if (!done) { print line; done = 1 } ; next }
    { print }
    END { if (!done) print line }
  ' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}

# ask VAR "Prompt" default
ask() {
  local __v="$1" prompt="$2" def="${3:-}" ans
  read -r -p "$prompt${def:+ [$def]}: " ans </dev/tty
  printf -v "$__v" '%s' "${ans:-$def}"
}

# ---------------------------------------------------------------- 1. Node
say "1/6 Node.js"
need_node=1
if command -v node >/dev/null; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [[ $major -ge 20 ]] && need_node=0
fi
if [[ $need_node -eq 1 ]]; then
  echo "Node 20 or newer is required and was not found."
  ask yn "Install Node 22 from NodeSource now? (y/n)" "y"
  [[ $yn == y* ]] || { echo "Install Node 20+ and re-run." >&2; exit 1; }
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "node $(node -v) at $(command -v node)"

npm install --no-audit --no-fund

# ---------------------------------------------------------------- 2. Docker check
say "2/6 Docker access"
if command -v docker >/dev/null && docker ps >/dev/null 2>&1; then
  echo "docker ps works as $SVC_USER."
  DETECTED_CONTAINERS="$(docker ps -a --format '{{.Names}}' | paste -sd, -)"
else
  echo "docker ps is not available to $SVC_USER. The docker_* tools will not work"
  echo "until an admin runs: sudo usermod -aG docker $SVC_USER   (then log out and in)."
  DETECTED_CONTAINERS=""
fi

# ---------------------------------------------------------------- 3. .env
say "3/6 Configuration (.env)"
if [[ ! -f $ENV_FILE ]]; then
  cp .env.example "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

ask SERVER_ID  "SERVER_ID (letters, digits, hyphens; no underscores)" "$(get_env SERVER_ID || true)"
[[ -n $SERVER_ID ]] || SERVER_ID="$(hostname -s | tr '_' '-')"
if [[ $SERVER_ID == *_* ]]; then echo "SERVER_ID must not contain underscores." >&2; exit 1; fi
ask CONTAINERS "ALLOWED_CONTAINERS (comma list, or *)" "$(get_env ALLOWED_CONTAINERS || true)"
[[ -n $CONTAINERS ]] || CONTAINERS="${DETECTED_CONTAINERS:-*}"
ask SERVICES   "ALLOWED_SERVICES" "$(get_env ALLOWED_SERVICES || echo nginx,docker,cloudflared,mcp-server)"
ask PATHS      "ALLOWED_PATHS for file/script tools (- disables them)" "$(get_env ALLOWED_PATHS || true)"
ask PORT       "Loopback PORT" "$(get_env PORT || echo 8787)"

set_env SERVER_ID "$SERVER_ID"
set_env ALLOWED_CONTAINERS "$CONTAINERS"
set_env ALLOWED_SERVICES "$SERVICES"
set_env PORT "$PORT"
if [[ $PATHS == "-" ]]; then
  sed -i 's|^ALLOWED_PATHS=|# ALLOWED_PATHS=|' "$ENV_FILE"
elif [[ -n $PATHS ]]; then
  set_env ALLOWED_PATHS "$PATHS"
fi
echo "Wrote $ENV_FILE (mode 600). Compose paths are left off; see README before enabling."

# ---------------------------------------------------------------- 4. cloudflared
say "4/6 cloudflared"
if ! command -v cloudflared >/dev/null; then
  case "$(uname -m)" in
    x86_64)  arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
  esac
  tmp="$(mktemp)"
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$arch" -o "$tmp"
  sudo install -m 755 "$tmp" /usr/local/bin/cloudflared
  rm -f "$tmp"
fi
cloudflared --version

cat <<MSG

------------------------------------------------------------------------
CLOUDFLARE STEP A: create the tunnel (dashboard, no API token needed)

  Zero Trust > Networks > Connectors > Cloudflare Tunnels > Create a tunnel
  - Type: Cloudflared. Name it after this box, e.g. "$SERVER_ID-mcp".
  - On the "install connector" screen, copy the long token from the
    command shown (the string after "cloudflared service install").
  - Next, add a Public hostname:
        Hostname: $SERVER_ID-mcp.<yourdomain>.com
        Service:  HTTP  ->  127.0.0.1:$PORT
    Cloudflare creates the proxied DNS record for you.
------------------------------------------------------------------------
MSG
if systemctl list-unit-files cloudflared.service >/dev/null 2>&1 \
   && systemctl list-unit-files | grep -q '^cloudflared.service'; then
  echo "A cloudflared service already exists on this box, skipping install."
  echo "(To replace it: sudo cloudflared service uninstall, then re-run.)"
else
  read -r -s -p "Paste the tunnel token (hidden, entered once): " TUNNEL_TOKEN </dev/tty; echo
  [[ -n $TUNNEL_TOKEN ]] || { echo "No token entered." >&2; exit 1; }
  sudo cloudflared service install "$TUNNEL_TOKEN"
  unset TUNNEL_TOKEN
fi

cat <<MSG

------------------------------------------------------------------------
CLOUDFLARE STEP B: service token and Access application

  Zero Trust > Access controls > Service credentials > Create service token
  - Name it after this box. Copy the Client ID and Client Secret now
    (the secret is shown once).

  Zero Trust > Access controls > Applications > Add > Self-hosted
  - Domain: $SERVER_ID-mcp.<yourdomain>.com
  - One policy, action "Service Auth" (not Allow), including that token.
------------------------------------------------------------------------
MSG
pause "Create the service token and application"

# ---------------------------------------------------------------- 5. credentials
say "5/6 Service token into .env"
cur_id="$(get_env ACCESS_CLIENT_ID || true)"
[[ $cur_id == REPLACE_ME* ]] && cur_id=""
ask ACCESS_ID "ACCESS_CLIENT_ID (ends in .access)" "$cur_id"
[[ $ACCESS_ID == *.access ]] || { echo "Client ID should end in .access" >&2; exit 1; }
read -r -s -p "ACCESS_CLIENT_SECRET (hidden; blank keeps existing): " ACCESS_SECRET </dev/tty; echo
set_env ACCESS_CLIENT_ID "$ACCESS_ID"
[[ -n $ACCESS_SECRET ]] && set_env ACCESS_CLIENT_SECRET "$ACCESS_SECRET"
unset ACCESS_SECRET
sec="$(get_env ACCESS_CLIENT_SECRET || true)"
[[ -n $sec && $sec != REPLACE_ME ]] || { echo "No client secret set." >&2; exit 1; }

# ---------------------------------------------------------------- 6. service
say "6/6 systemd service"
NODE_BIN="$(command -v node)"
tmp="$(mktemp)"
sed -e "s|^User=.*|User=$SVC_USER|" \
    -e "s|^WorkingDirectory=.*|WorkingDirectory=$DIR|" \
    -e "s|^EnvironmentFile=.*|EnvironmentFile=$ENV_FILE|" \
    -e "s|^ExecStart=.*|ExecStart=$NODE_BIN src/index.js|" \
    mcp-server.service.example > "$tmp"
sudo install -m 644 "$tmp" /etc/systemd/system/mcp-server.service
rm -f "$tmp"
sudo systemctl daemon-reload
sudo systemctl enable mcp-server >/dev/null
sudo systemctl restart mcp-server
sleep 2
systemctl is-active --quiet mcp-server || {
  echo "mcp-server failed to start. Logs:" >&2
  journalctl -u mcp-server -n 25 --no-pager >&2
  exit 1
}

echo
echo "Running smoke test (loopback, bypasses the tunnel)..."
if ./smoke-test.sh; then
  smoke="passed"
else
  smoke="FAILED (fix this before continuing)"
fi

cat <<MSG

Done on this box. Smoke test: $smoke

Remaining Cloudflare steps (README steps 4 to 6):
  4. AI controls > MCP servers > add "$SERVER_ID"
       URL: https://$SERVER_ID-mcp.<yourdomain>.com/mcp
       Then Edit > Authentication, add four custom headers:
         CF-Access-Client-Id / CF-Access-Client-Secret
         X-Internal-Client-Id / X-Internal-Client-Secret
       (same Client ID and secret in each pair), and attach your policy.
  5. AI controls > Portals: add this server, turn "Require user auth" OFF
     for it, and enable Managed OAuth (5b).
  6. Add the portal URL to Claude.
MSG
