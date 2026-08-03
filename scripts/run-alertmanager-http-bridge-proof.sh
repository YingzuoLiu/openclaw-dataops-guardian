#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-alertmanager-http-bridge.XXXXXX")"

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19185}"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}"

BRIDGE_PORT="${ALERTMANAGER_BRIDGE_PORT:-19186}"
ALERTMANAGER_BRIDGE_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export ALERTMANAGER_BRIDGE_TOKEN
export ALERTMANAGER_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"
BRIDGE_STATE_DIR="$RUNTIME_DIR/bridge-state"
export ALERTMANAGER_BRIDGE_STATE_DIR="$BRIDGE_STATE_DIR"
FIXTURE_PATH="$RUNTIME_DIR/fixture.json"
CRASH_BRIDGE_STATE_PATH="$RUNTIME_DIR/crash-bridge-state.json"
CRASH_MARKER_PATH="$RUNTIME_DIR/crash-marker.json"

GATEWAY_PID=""
BRIDGE_PID=""

wait_for_tcp_port() {
  local port="$1"
  local label="$2"
  local pid_var_name="$3"
  for _ in $(seq 1 80); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    local pid="${!pid_var_name}"
    if [[ -n "$pid" ]] && ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  echo "$label did not become ready" >&2
  return 1
}

start_gateway() {
  local log_file="$1"
  "$ROOT_DIR/node_modules/.bin/openclaw" gateway run \
    --port "$OPENCLAW_GATEWAY_PORT" \
    --bind loopback \
    --auth token \
    --allow-unconfigured >"$log_file" 2>&1 &
  GATEWAY_PID=$!
  wait_for_tcp_port "$OPENCLAW_GATEWAY_PORT" "Gateway" GATEWAY_PID
}

stop_gateway() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  GATEWAY_PID=""
}

start_bridge() {
  local log_file="$1"
  mkdir -p "$BRIDGE_STATE_DIR"
  ALERTMANAGER_BRIDGE_HOST=127.0.0.1 \
  ALERTMANAGER_BRIDGE_PORT="$BRIDGE_PORT" \
  ALERTMANAGER_BRIDGE_TOKEN="$ALERTMANAGER_BRIDGE_TOKEN" \
  ALERTMANAGER_BRIDGE_STATE_DIR="$BRIDGE_STATE_DIR" \
  OPENCLAW_GATEWAY_URL="$OPENCLAW_GATEWAY_URL" \
  OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
    node "$ROOT_DIR/dist/alertmanager/http-bridge/run.js" >"$log_file" 2>&1 &
  BRIDGE_PID=$!
  wait_for_tcp_port "$BRIDGE_PORT" "Bridge" BRIDGE_PID
}

stop_bridge() {
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -TERM "$BRIDGE_PID"
    wait "$BRIDGE_PID" || true
  fi
  BRIDGE_PID=""
}

cleanup() {
  stop_bridge
  stop_gateway
  "$ROOT_DIR/node_modules/.bin/openclaw" config unset \
    gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null 2>&1 || true
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-alertmanager-http-bridge.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap cleanup EXIT

run_proof_phase() {
  node "$ROOT_DIR/scripts/alertmanager-http-bridge-proof.mjs" "$1" "$FIXTURE_PATH"
}

mkdir -p "$OPENCLAW_STATE_DIR" "$BRIDGE_STATE_DIR"
cd "$ROOT_DIR"
npm run build

"$ROOT_DIR/node_modules/.bin/openclaw" plugins install --link "$ROOT_DIR" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.mode local >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null

# --- Bridge instance #1: request validation, core routing, and the first
#     deferred checkpoint (blocking remediation attempt still running). ---
start_gateway "$RUNTIME_DIR/gateway-1.log"
start_bridge "$RUNTIME_DIR/bridge-1.log"
run_proof_phase preflight

# --- A canonicalized webhook must leave a durable, metadata-only audit
#     record (no raw payload/labels/annotations/token), visible even when
#     Alertmanager truncated alerts out of the payload. ---
run_proof_phase truncated-alerts-audit

run_proof_phase core-and-defer

# --- A second, differing deferred delivery for the same fingerprint must be
#     rejected (fail closed) rather than overwriting the first, already
#     2xx-acknowledged one. ---
run_proof_phase checkpoint-conflict

# --- A delayed delivery for an occurrence older than the fingerprint's
#     active one must never move the route backward, whether firing or
#     resolved. ---
run_proof_phase route-regression

# --- A delivery that loses a receivedAt ordering race against a concurrent
#     request for the same fingerprint must fail closed (503), never be
#     silently confirmed away inside a 2xx; a retry after the transient
#     condition clears must succeed. ---
run_proof_phase delivery-ordering-conflict
stop_bridge

# --- Bridge instance #2: restart while the checkpoint's blocking attempt is
#     still running. The held delivery must remain held, not replayed or
#     lost. ---
start_bridge "$RUNTIME_DIR/bridge-2.log"
run_proof_phase verify-checkpoint-still-held

# --- Gateway goes down while the bridge (#2) stays up: any persistence
#     attempt must fail closed with 503, never a silent 2xx. ---
stop_gateway
run_proof_phase persistence-failure

# --- Gateway restart: state must survive without the bridge restarting.
#     Nothing about the held delivery has changed, so this is the same
#     assertion as the bridge-restart check above. The bridge process (#2)
#     was never restarted, so its own long-lived GatewayClient has to
#     reconnect on its own; that reconnect uses exponential backoff up to a
#     30s cap, which is not bounded by anything this script controls, so a
#     bounded readiness probe (never a fixed sleep) runs first rather than
#     asserting against the very next request. ---
start_gateway "$RUNTIME_DIR/gateway-2.log"
run_proof_phase wait-for-gateway-reachable
run_proof_phase verify-checkpoint-still-held

# --- Settle the blocking attempt out of band and drain the checkpoint. ---
run_proof_phase settle-and-drain
stop_bridge

# --- Bridge instance #3: restart after settlement. The route to the
#     replayed occurrence must survive on disk. ---
start_bridge "$RUNTIME_DIR/bridge-3.log"
run_proof_phase verify-replayed-occurrence
stop_bridge

# --- Crash window: destination write durable, process killed before the
#     checkpoint is deleted. Recovery must not lose or double-apply it. ---
mkdir -p "$(dirname "$CRASH_BRIDGE_STATE_PATH")"
set +e
node "$ROOT_DIR/scripts/alertmanager-http-bridge-crash-proof.mjs" \
  crash "$CRASH_BRIDGE_STATE_PATH" "$CRASH_MARKER_PATH"
crash_exit=$?
set -e
if [[ "$crash_exit" -eq 0 ]]; then
  echo "Crash phase exited normally; crash window was not exercised" >&2
  exit 1
fi
if [[ ! -f "$CRASH_MARKER_PATH" ]]; then
  echo "Crash phase terminated before the destination write marker was durable" >&2
  exit 1
fi
node "$ROOT_DIR/scripts/alertmanager-http-bridge-crash-proof.mjs" \
  recover "$CRASH_BRIDGE_STATE_PATH" "$CRASH_MARKER_PATH"

stop_gateway

echo '{"ok":true,"proof":"alertmanager-http-bridge"}'
