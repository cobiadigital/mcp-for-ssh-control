#!/usr/bin/env bash
# Smoke test for the internal service. Run it on the Lightsail box (or
# anywhere that can reach the service) after starting server.js:
#
#   ACCESS_CLIENT_ID=... ACCESS_CLIENT_SECRET=... ./smoke-test.sh [base-url]
#
# It verifies the two security properties end to end:
#   - requests without / with wrong Access service-token headers are rejected (401)
#   - non-allowlisted container/service names are rejected (403), and unknown
#     commands are rejected (400)
# plus one happy-path command (uptime) to prove the service actually works.

set -u

BASE_URL="${1:-http://127.0.0.1:8787}"
ID="${ACCESS_CLIENT_ID:-}"
SECRET="${ACCESS_CLIENT_SECRET:-}"

if [[ -z "$ID" || -z "$SECRET" ]]; then
  echo "ERROR: set ACCESS_CLIENT_ID and ACCESS_CLIENT_SECRET in the environment" >&2
  exit 2
fi

PASS=0
FAIL=0

# check <description> <expected-http-status> <curl args...>
check() {
  local desc="$1" expected="$2"
  shift 2
  local status
  status=$(curl -s -o /tmp/smoke-body.$$ -w "%{http_code}" --max-time 15 "$@")
  if [[ "$status" == "$expected" ]]; then
    echo "PASS: $desc (HTTP $status)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $desc — expected HTTP $expected, got $status"
    sed 's/^/      /' /tmp/smoke-body.$$
    FAIL=$((FAIL + 1))
  fi
  rm -f /tmp/smoke-body.$$
}

AUTH=(-H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: $SECRET")
JSON=(-H "Content-Type: application/json")

echo "== Auth checks =="
check "no auth headers rejected" 401 \
  "$BASE_URL/healthz"

check "wrong secret rejected" 401 \
  -H "CF-Access-Client-Id: $ID" -H "CF-Access-Client-Secret: definitely-wrong" \
  "$BASE_URL/healthz"

check "wrong client id rejected" 401 \
  -H "CF-Access-Client-Id: not-a-real-id.access" -H "CF-Access-Client-Secret: $SECRET" \
  "$BASE_URL/healthz"

check "valid token accepted on /healthz" 200 \
  "${AUTH[@]}" "$BASE_URL/healthz"

echo
echo "== Whitelist checks =="
check "unknown command rejected" 400 \
  "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"command":"rm_rf_slash"}' \
  "$BASE_URL/run"

check "non-allowlisted container rejected" 403 \
  "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"command":"docker_restart","args":{"container":"not-on-the-list"}}' \
  "$BASE_URL/run"

check "shell-metacharacter container name rejected" 400 \
  "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"command":"docker_logs","args":{"container":"foo; rm -rf /"}}' \
  "$BASE_URL/run"

check "option-injection container name rejected" 400 \
  "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"command":"docker_logs","args":{"container":"--help"}}' \
  "$BASE_URL/run"

check "non-allowlisted service rejected" 403 \
  "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"command":"service_status","args":{"service":"sshd"}}' \
  "$BASE_URL/run"

echo
echo "== Happy path =="
check "uptime runs" 200 \
  "${AUTH[@]}" "${JSON[@]}" -X POST -d '{"command":"uptime"}' \
  "$BASE_URL/run"

echo
echo "Result: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
