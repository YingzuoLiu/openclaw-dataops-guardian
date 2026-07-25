#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_DIR="$ROOT_DIR/spikes/day0-kind-connectivity"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-day0-deny.XXXXXX")"

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19185}"

GATEWAY_PID=""

cleanup() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  "$ROOT_DIR/node_modules/.bin/openclaw" config unset \
    gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null 2>&1 || true
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-day0-deny.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap cleanup EXIT

mkdir -p "$OPENCLAW_STATE_DIR"

"$ROOT_DIR/node_modules/.bin/openclaw" plugins install \
  --link "$SPIKE_DIR" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.mode local >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  plugins.entries.guardian-day0-kind-connectivity.config.kubeconfigPath \
  "$RUNTIME_DIR/does-not-exist" >/dev/null

"$ROOT_DIR/node_modules/.bin/openclaw" gateway run \
  --port "$OPENCLAW_GATEWAY_PORT" \
  --bind loopback \
  --auth token \
  --allow-unconfigured >"$RUNTIME_DIR/gateway.log" 2>&1 &
GATEWAY_PID=$!

for _ in $(seq 1 80); do
  if (exec 3<>/dev/tcp/127.0.0.1/"$OPENCLAW_GATEWAY_PORT") 2>/dev/null; then
    exec 3>&-
    exec 3<&-
    node "$SPIKE_DIR/rpc.mjs" deny-only
    exit 0
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    break
  fi
  sleep 0.25
done

echo "Gateway did not become ready for deny-only proof" >&2
exit 1
