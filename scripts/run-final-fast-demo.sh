#!/usr/bin/env bash
set -euo pipefail

# No Docker, cluster, external model, or paid API is used here. Successful
# stdout is limited to the allowlisted summary from final-proof-report.mjs;
# failures emit a bounded local diagnostic tail before temporary cleanup.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d /tmp/guardian-final-fast.XXXXXX)"
STAGED_GUARDIAN_DIR="$RUNTIME_DIR/plugins/dataops-guardian"
STAGED_LOBSTER_DIR="$RUNTIME_DIR/plugins/lobster"
CURRENT_COMPONENT="initialization"
CURRENT_LOG=""

cleanup() {
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == /tmp/guardian-final-fast.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}

failed() {
  local status=$?
  trap - ERR
  echo "demo:fast failed during ${CURRENT_COMPONENT}" >&2
  if [[ -n "$CURRENT_LOG" && -s "$CURRENT_LOG" ]]; then
    echo "last component diagnostic lines:" >&2
    tail -n 120 "$CURRENT_LOG" >&2 || true
  fi
  exit "$status"
}

trap failed ERR
trap cleanup EXIT

pick_free_ports() {
  node -e '
    const net = require("node:net");
    const servers = Array.from({ length: 8 }, () => net.createServer());
    Promise.all(servers.map((server) => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    }))).then(async (ports) => {
      await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
      process.stdout.write(`${ports.join(" ")}\n`);
    });
  '
}

cd "$ROOT_DIR"
read -r \
  LIVE_GATEWAY_PORT LIVE_MODEL_PORT \
  BRIDGE_GATEWAY_PORT BRIDGE_HTTP_PORT \
  APPROVE_GATEWAY_PORT APPROVE_PROMETHEUS_PORT \
  DENY_GATEWAY_PORT DENY_PROMETHEUS_PORT < <(pick_free_ports)

# OpenClaw rejects world-writable plugin roots. Windows-mounted WSL checkouts
# commonly appear world-writable even when the Windows ACL is restrictive, so
# load proof-owned plugin copies from the Linux filesystem. This follows the
# same load-path boundary as the live proof without copying the dependency tree.
CURRENT_COMPONENT="safe proof staging"
CURRENT_LOG="$RUNTIME_DIR/staging.log"
{
  npm run build
  mkdir -p "$STAGED_GUARDIAN_DIR" "$STAGED_LOBSTER_DIR"
  cp \
    "$ROOT_DIR/package.json" \
    "$ROOT_DIR/openclaw.plugin.json" \
    "$STAGED_GUARDIAN_DIR/"
  cp -R "$ROOT_DIR/dist" "$STAGED_GUARDIAN_DIR/dist"
  ln -s "$ROOT_DIR/node_modules" "$STAGED_GUARDIAN_DIR/node_modules"
  cp -R "$ROOT_DIR/node_modules/@openclaw/lobster/." "$STAGED_LOBSTER_DIR/"
  chmod -R go-w "$STAGED_GUARDIAN_DIR" "$STAGED_LOBSTER_DIR"
} >"$CURRENT_LOG" 2>&1

CURRENT_COMPONENT="policy registration"
CURRENT_LOG="$RUNTIME_DIR/policy.log"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/policy" \
GUARDIAN_PROOF_PLUGIN_DIR="$STAGED_GUARDIAN_DIR" \
  bash scripts/run-policy-registration-proof.sh >"$CURRENT_LOG" 2>&1

CURRENT_COMPONENT="live Agent hook"
CURRENT_LOG="$RUNTIME_DIR/live-hook.log"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/live-hook" \
OPENCLAW_GATEWAY_PORT="$LIVE_GATEWAY_PORT" \
GUARDIAN_MOCK_MODEL_PORT="$LIVE_MODEL_PORT" \
OPENCLAW_WORKSPACE_DIR="$RUNTIME_DIR/live-hook-workspace" \
GUARDIAN_PROOF_PLUGIN_DIR="$STAGED_GUARDIAN_DIR" \
  bash scripts/run-live-hook-invocation-proof.sh >"$CURRENT_LOG" 2>&1

CURRENT_COMPONENT="Alertmanager HTTP bridge"
CURRENT_LOG="$RUNTIME_DIR/bridge.log"
OPENCLAW_GATEWAY_PORT="$BRIDGE_GATEWAY_PORT" \
ALERTMANAGER_BRIDGE_PORT="$BRIDGE_HTTP_PORT" \
GUARDIAN_PROOF_PLUGIN_DIR="$STAGED_GUARDIAN_DIR" \
  bash scripts/run-alertmanager-http-bridge-proof.sh >"$CURRENT_LOG" 2>&1

CURRENT_COMPONENT="synthetic approval"
CURRENT_LOG="$RUNTIME_DIR/approve.log"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/approve" \
OPENCLAW_GATEWAY_PORT="$APPROVE_GATEWAY_PORT" \
GUARDIAN_MOCK_PROMETHEUS_PORT="$APPROVE_PROMETHEUS_PORT" \
OPENCLAW_VERTICAL_SESSION_KEY="agent:main:dataops-guardian-final-fast-approve" \
OPENCLAW_VERTICAL_RESUME_FILE="$RUNTIME_DIR/approve-resume.json" \
LOBSTER_STATE_DIR="$RUNTIME_DIR/approve-lobster" \
GUARDIAN_PROOF_PLUGIN_DIR="$STAGED_GUARDIAN_DIR" \
GUARDIAN_PROOF_LOBSTER_PLUGIN_DIR="$STAGED_LOBSTER_DIR" \
GUARDIAN_PROOF_DECISION=approve \
  bash scripts/run-vertical-slice-proof.sh >"$CURRENT_LOG" 2>&1

CURRENT_COMPONENT="synthetic denial"
CURRENT_LOG="$RUNTIME_DIR/deny.log"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/deny" \
OPENCLAW_GATEWAY_PORT="$DENY_GATEWAY_PORT" \
GUARDIAN_MOCK_PROMETHEUS_PORT="$DENY_PROMETHEUS_PORT" \
OPENCLAW_VERTICAL_SESSION_KEY="agent:main:dataops-guardian-final-fast-deny" \
OPENCLAW_VERTICAL_RESUME_FILE="$RUNTIME_DIR/deny-resume.json" \
LOBSTER_STATE_DIR="$RUNTIME_DIR/deny-lobster" \
GUARDIAN_PROOF_PLUGIN_DIR="$STAGED_GUARDIAN_DIR" \
GUARDIAN_PROOF_LOBSTER_PLUGIN_DIR="$STAGED_LOBSTER_DIR" \
GUARDIAN_PROOF_DECISION=deny \
  bash scripts/run-vertical-slice-proof.sh >"$CURRENT_LOG" 2>&1

CURRENT_COMPONENT="sanitized summary"
CURRENT_LOG=""
node scripts/final-proof-report.mjs fast \
  "$RUNTIME_DIR/policy.log" \
  "$RUNTIME_DIR/live-hook.log" \
  "$RUNTIME_DIR/bridge.log" \
  "$RUNTIME_DIR/approve.log" \
  "$RUNTIME_DIR/deny.log"
