#!/usr/bin/env bash
#
# Verify the MCP server on this box before wiring it up to Cloudflare.
# Run it ON the box, against loopback — this deliberately bypasses the tunnel
# so a failure here is unambiguously the service's fault, not the network's.
#
#   cd ~/mcp-for-ssh-control/mcp-server && ./smoke-test.sh
#
# It checks that unauthenticated requests are refused, that the MCP handshake
# works, that every tool is advertised, and that the allowlists actually bite.

set -uo pipefail

PORT="${PORT:-8787}"
URL="http://127.0.0.1:${PORT}/mcp"

if [[ -f .env ]]; then
  # shellcheck disable=SC1091
  set -a; source .env; set +a
fi

if [[ -z "${ACCESS_CLIENT_ID:-}" || -z "${ACCESS_CLIENT_SECRET:-}" ]]; then
  echo "FAIL: ACCESS_CLIENT_ID / ACCESS_CLIENT_SECRET not found (no .env in $PWD?)"
  exit 1
fi

pass=0
fail=0

ok()   { echo "  ok    $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); }

# POST a JSON-RPC body with the service-token headers.
rpc() {
  curl -s --max-time 20 -X POST "$URL" \
    -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -H "X-Internal-Client-Id: ${ACCESS_CLIENT_ID}" \
    -H "X-Internal-Client-Secret: ${ACCESS_CLIENT_SECRET}" \
    -d "$1"
}

echo "Testing MCP server at ${URL}"
echo

echo "1. Authentication"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$URL" \
  -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[[ "$code" == "401" ]] && ok "no credentials rejected (401)" || bad "no credentials returned $code, expected 401"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$URL" \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Client-Id: ${ACCESS_CLIENT_ID}" \
  -H 'X-Internal-Client-Secret: definitely-wrong' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
[[ "$code" == "401" ]] && ok "wrong secret rejected (401)" || bad "wrong secret returned $code, expected 401"

echo
echo "2. MCP handshake"

init=$(rpc '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-test","version":"2.0.0"}}}')
if grep -q '"serverInfo"' <<<"$init"; then
  ok "initialize: $(grep -o '"name":"[^"]*"' <<<"$init" | head -1)"
else
  bad "initialize failed: $init"
fi

tools=$(rpc '{"jsonrpc":"2.0","id":2,"method":"tools/list"}')
count=$(grep -o '"name":"[a-z_]*"' <<<"$tools" | wc -l)
if [[ "$count" -ge 14 ]]; then
  ok "tools/list advertised $count tools"
else
  bad "tools/list advertised $count tools, expected 14 — response: ${tools:0:300}"
fi

echo
echo "3. Tools run"

for tool in server_info uptime disk_usage memory_usage; do
  out=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"${tool}\",\"arguments\":{}}}")
  if grep -q '"isError":true' <<<"$out" || ! grep -q '"content"' <<<"$out"; then
    bad "${tool}: ${out:0:200}"
  else
    ok "${tool}"
  fi
done

echo
echo "4. Allowlists reject what they should"

out=$(rpc '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"docker_restart","arguments":{"container":"definitely-not-allowlisted"}}}')
grep -q 'not on this server' <<<"$out" && ok "container off the allowlist refused" || bad "container allowlist did not bite: ${out:0:200}"

out=$(rpc '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"service_status","arguments":{"service":"definitely-not-allowlisted"}}}')
grep -q 'not on this server' <<<"$out" && ok "service off the allowlist refused" || bad "service allowlist did not bite: ${out:0:200}"

out=$(rpc '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/etc/shadow"}}}')
if grep -q 'outside this server' <<<"$out" || grep -q 'are disabled' <<<"$out"; then
  ok "path outside the allowed roots refused"
else
  bad "path jail did not bite: ${out:0:200}"
fi

echo
echo "5. The v1 endpoint is gone"

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "http://127.0.0.1:${PORT}/run" \
  -H 'Content-Type: application/json' \
  -H "X-Internal-Client-Id: ${ACCESS_CLIENT_ID}" \
  -H "X-Internal-Client-Secret: ${ACCESS_CLIENT_SECRET}" \
  -d '{"command":"uptime"}')
[[ "$code" == "404" ]] && ok "POST /run returns 404 (v1 API removed)" || bad "POST /run returned $code, expected 404"

echo
echo "-----------------------------------------"
echo "passed: ${pass}   failed: ${fail}"
[[ "$fail" -eq 0 ]] || exit 1
echo
echo "This box is ready. Next: point a Cloudflare Tunnel at 127.0.0.1:${PORT}"
echo "and add it as an MCP server in Zero Trust > Access controls > AI controls."
