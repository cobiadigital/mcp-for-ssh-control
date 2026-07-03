#!/usr/bin/env bash
# User-level launcher for the internal service — no sudo needed.
#
# Reads config from a `.env` file kept next to this script (gitignored, so
# `git pull` never touches it), then starts the server. Typical use with pm2:
#
#   pm2 start ./start.sh --name lightsail-mcp-internal
#
# .env contents (chmod 600):
#   ACCESS_CLIENT_ID=xxxx.access
#   ACCESS_CLIENT_SECRET=xxxx
#   ALLOWED_CONTAINERS=wordpress,odoo,wanderer,crm
#   ALLOWED_SERVICES=nginx,docker,cloudflared
#   PORT=8787

set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  echo "ERROR: no .env file found in $(pwd) — copy the template from the README (chmod 600)." >&2
  exit 1
fi

set -a          # export everything sourced below so node sees it
source ./.env
set +a

exec node server.js
