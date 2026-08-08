#!/usr/bin/env bash
set -euo pipefail

# No Docker, cluster, external model, or paid API is used here. Component
# stdout stays in a proof-owned temporary directory; only the allowlisted
# summary produced by final-proof-report.mjs is released.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-final-fast.XXXXXX")"
CURRENT_COMPONENT="initialization"

cleanup() {
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-final-fast.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}

failed() {
  local status=$?
  echo "demo:fast failed during ${CURRENT_COMPONENT}" >&2
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

CURRENT_COMPONENT="policy registration"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/policy" \
  bash scripts/run-policy-registration-proof.sh >"$RUNTIME_DIR/policy.log" 2>&1

CURRENT_COMPONENT="live Agent hook"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/live-hook" \
OPENCLAW_GATEWAY_PORT="$LIVE_GATEWAY_PORT" \
GUARDIAN_MOCK_MODEL_PORT="$LIVE_MODEL_PORT" \
OPENCLAW_WORKSPACE_DIR="$RUNTIME_DIR/live-hook-workspace" \
  bash scripts/run-live-hook-invocation-proof.sh >"$RUNTIME_DIR/live-hook.log" 2>&1

CURRENT_COMPONENT="Alertmanager HTTP bridge"
OPENCLAW_GATEWAY_PORT="$BRIDGE_GATEWAY_PORT" \
ALERTMANAGER_BRIDGE_PORT="$BRIDGE_HTTP_PORT" \
  bash scripts/run-alertmanager-http-bridge-proof.sh >"$RUNTIME_DIR/bridge.log" 2>&1

CURRENT_COMPONENT="synthetic approval"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/approve" \
OPENCLAW_GATEWAY_PORT="$APPROVE_GATEWAY_PORT" \
GUARDIAN_MOCK_PROMETHEUS_PORT="$APPROVE_PROMETHEUS_PORT" \
OPENCLAW_VERTICAL_SESSION_KEY="agent:main:dataops-guardian-final-fast-approve" \
OPENCLAW_VERTICAL_RESUME_FILE="$RUNTIME_DIR/approve-resume.json" \
LOBSTER_STATE_DIR="$RUNTIME_DIR/approve-lobster" \
GUARDIAN_PROOF_DECISION=approve \
  bash scripts/run-vertical-slice-proof.sh >"$RUNTIME_DIR/approve.log" 2>&1

CURRENT_COMPONENT="synthetic denial"
OPENCLAW_STATE_DIR="$RUNTIME_DIR/deny" \
OPENCLAW_GATEWAY_PORT="$DENY_GATEWAY_PORT" \
GUARDIAN_MOCK_PROMETHEUS_PORT="$DENY_PROMETHEUS_PORT" \
OPENCLAW_VERTICAL_SESSION_KEY="agent:main:dataops-guardian-final-fast-deny" \
OPENCLAW_VERTICAL_RESUME_FILE="$RUNTIME_DIR/deny-resume.json" \
LOBSTER_STATE_DIR="$RUNTIME_DIR/deny-lobster" \
GUARDIAN_PROOF_DECISION=deny \
  bash scripts/run-vertical-slice-proof.sh >"$RUNTIME_DIR/deny.log" 2>&1

CURRENT_COMPONENT="sanitized summary"
node scripts/final-proof-report.mjs fast \
  "$RUNTIME_DIR/policy.log" \
  "$RUNTIME_DIR/live-hook.log" \
  "$RUNTIME_DIR/bridge.log" \
  "$RUNTIME_DIR/approve.log" \
  "$RUNTIME_DIR/deny.log"
