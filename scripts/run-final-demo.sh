#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-final-demo.XXXXXX")"
CURRENT_COMPONENT="prerequisite checks"

cleanup() {
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-final-demo.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}

failed() {
  local status=$?
  local log_file=""
  trap - ERR
  echo "demo failed during ${CURRENT_COMPONENT}" >&2
  case "$CURRENT_COMPONENT" in
    "fast proof")
      log_file="$RUNTIME_DIR/fast.log"
      ;;
    "kind safety proof")
      log_file="$RUNTIME_DIR/kind.log"
      ;;
  esac
  if [[ -n "$log_file" && -s "$log_file" ]]; then
    echo "last diagnostic lines:" >&2
    tail -n 120 "$log_file" >&2
  fi
  exit "$status"
}

trap failed ERR
trap cleanup EXIT

cd "$ROOT_DIR"
for command in docker kind kubectl; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "demo prerequisite is missing: $command" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "demo requires a reachable Docker daemon" >&2
  exit 1
fi

CURRENT_COMPONENT="fast proof"
bash scripts/run-final-fast-demo.sh >"$RUNTIME_DIR/fast.json" 2>"$RUNTIME_DIR/fast.log"

CURRENT_COMPONENT="kind safety proof"
GUARDIAN_FINAL_DEMO=1 \
GUARDIAN_FINAL_REPORT_PATH="$RUNTIME_DIR/kind.json" \
  bash scripts/run-kind-prometheus-recovery-proof.sh >"$RUNTIME_DIR/kind.log" 2>&1

CURRENT_COMPONENT="sanitized summary"
node scripts/final-proof-report.mjs full \
  "$RUNTIME_DIR/fast.json" "$RUNTIME_DIR/kind.json"
