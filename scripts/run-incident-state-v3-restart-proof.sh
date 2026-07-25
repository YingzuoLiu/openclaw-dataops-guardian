#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-state-v3.XXXXXX")"

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19184}"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"

GATEWAY_PID=""

stop_gateway() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  GATEWAY_PID=""
}

cleanup() {
  stop_gateway
  "$ROOT_DIR/node_modules/.bin/openclaw" config unset \
    gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null 2>&1 || true
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-state-v3.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap cleanup EXIT

start_gateway() {
  local log_file="$1"
  "$ROOT_DIR/node_modules/.bin/openclaw" gateway run \
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
    if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done

  echo "Gateway did not become ready" >&2
  return 1
}

mkdir -p "$OPENCLAW_STATE_DIR"
cd "$ROOT_DIR"
npm run build
"$ROOT_DIR/node_modules/.bin/openclaw" plugins install --link "$ROOT_DIR" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.mode local >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null

start_gateway "$RUNTIME_DIR/gateway-write.log"
npm run state:v3:rpc -- write
stop_gateway

start_gateway "$RUNTIME_DIR/gateway-read.log"
npm run state:v3:rpc -- read
stop_gateway
