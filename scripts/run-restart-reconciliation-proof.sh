#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROOF_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-restart-reconciliation.XXXXXX")"
CHECKPOINT_PATH="$PROOF_DIR/bridge-checkpoint.json"
EXTERNAL_AUDIT_PATH="$PROOF_DIR/external-audit.json"

cleanup() {
  if [[ -d "$PROOF_DIR" && "$PROOF_DIR" == "${TMPDIR:-/tmp}"/guardian-restart-reconciliation.* ]]; then
    find "$PROOF_DIR" -depth -delete
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"
npm run build

set +e
node scripts/restart-reconciliation-proof.mjs \
  dispatch-and-terminate "$CHECKPOINT_PATH" "$EXTERNAL_AUDIT_PATH"
dispatch_exit=$?
set -e

if [[ "$dispatch_exit" -eq 0 ]]; then
  echo "Dispatch process exited normally; crash window was not exercised" >&2
  exit 1
fi
if [[ ! -f "$CHECKPOINT_PATH" || ! -f "$EXTERNAL_AUDIT_PATH" ]]; then
  echo "Dispatch process terminated before proof artifacts were durable" >&2
  exit 1
fi

node scripts/restart-reconciliation-proof.mjs \
  reconcile "$CHECKPOINT_PATH" "$EXTERNAL_AUDIT_PATH"
