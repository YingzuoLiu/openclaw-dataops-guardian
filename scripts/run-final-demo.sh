#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/guardian-proof-native-stage.sh"
guardian_reexec_proof_on_native_fs \
  "$ROOT_DIR" "scripts/run-final-demo.sh" "demo"
guardian_require_proof_source_commit "$ROOT_DIR"

RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-final-demo.XXXXXX")"
CURRENT_COMPONENT="prerequisite checks"
PROGRESS_FD="${GUARDIAN_FINAL_PROGRESS_FD:-2}"

progress() {
  printf '[demo] %s\n' "$1" >&"$PROGRESS_FD"
}

run_bounded() {
  local duration="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    # Leave enough time for the child runner's EXIT trap to delete its cluster,
    # images, credentials, and temporary files after the deadline signal.
    timeout --signal=TERM --kill-after=300s "$duration" "$@"
  else
    "$@"
  fi
}

cleanup() {
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-final-demo.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}

failed() {
  local status="${1:-$?}"
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

run_component() {
  local duration="$1"
  local log_file="$2"
  local status
  shift 2

  set +e
  run_bounded "$duration" "$@" >"$log_file" 2>&1
  status=$?
  set -e
  if ((status != 0)); then
    failed "$status"
  fi
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
progress "$CURRENT_COMPONENT"
GUARDIAN_FINAL_PROGRESS_FD=3 \
  bash scripts/run-final-fast-demo.sh \
  3>&2 >"$RUNTIME_DIR/fast.json" 2>"$RUNTIME_DIR/fast.log"

CURRENT_COMPONENT="kind safety proof"
progress "$CURRENT_COMPONENT"
run_component 1800s "$RUNTIME_DIR/kind.log" env \
  GUARDIAN_FINAL_DEMO=1 \
  GUARDIAN_FINAL_REPORT_PATH="$RUNTIME_DIR/kind.json" \
  GUARDIAN_FINAL_PROGRESS_FD=3 \
  bash scripts/run-kind-prometheus-recovery-proof.sh \
  3>&2

CURRENT_COMPONENT="sanitized summary"
progress "$CURRENT_COMPONENT"
node scripts/final-proof-report.mjs full \
  "$RUNTIME_DIR/fast.json" "$RUNTIME_DIR/kind.json"
