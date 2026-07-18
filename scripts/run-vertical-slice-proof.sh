#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$PWD/.openclaw-proof}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-guardian-vertical-slice-proof-local-only}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19183}"
export OPENCLAW_VERTICAL_SESSION_KEY="${OPENCLAW_VERTICAL_SESSION_KEY:-agent:main:dataops-guardian-vertical-slice-script}"
export OPENCLAW_VERTICAL_RESUME_FILE="${OPENCLAW_VERTICAL_RESUME_FILE:-$OPENCLAW_STATE_DIR/vertical-slice-script-resume.json}"
export LOBSTER_STATE_DIR="${LOBSTER_STATE_DIR:-$OPENCLAW_STATE_DIR/lobster-state}"

DECISION="${GUARDIAN_PROOF_DECISION:-approve}"
if [[ "$DECISION" != "approve" && "$DECISION" != "deny" ]]; then
  echo "GUARDIAN_PROOF_DECISION must be approve or deny" >&2
  exit 2
fi

npm run build
./node_modules/.bin/openclaw config set gateway.mode local >/dev/null
./node_modules/.bin/openclaw config set gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
./node_modules/.bin/openclaw config set tools.alsoAllow '["lobster"]' >/dev/null
./node_modules/.bin/openclaw config set gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
./node_modules/.bin/openclaw plugins install --link "$PWD" >/dev/null
./node_modules/.bin/openclaw plugins install --link "$PWD/node_modules/@openclaw/lobster" >/dev/null

start_gateway() {
  local log_file="$1"
  ./node_modules/.bin/openclaw gateway run \
    --port "$OPENCLAW_GATEWAY_PORT" \
    --bind loopback \
    --auth token \
    --allow-unconfigured >"$log_file" 2>&1 &
  GATEWAY_PID=$!

  for _ in $(seq 1 80); do
    if (exec 3<>/dev/tcp/127.0.0.1/"$OPENCLAW_GATEWAY_PORT") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    sleep 0.25
  done

  echo "Gateway did not become ready" >&2
  return 1
}

stop_gateway() {
  if [[ -n "${GATEWAY_PID:-}" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
}

cleanup() {
  stop_gateway
  ./node_modules/.bin/openclaw config unset \
    gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null || true
}
trap cleanup EXIT

start_gateway "$OPENCLAW_STATE_DIR/gateway-vertical-slice-proof-start.log"
npm run slice:rpc -- start
stop_gateway

start_gateway "$OPENCLAW_STATE_DIR/gateway-vertical-slice-proof-resume.log"
npm run slice:rpc -- resume "$DECISION"
npm run slice:rpc -- show
stop_gateway
