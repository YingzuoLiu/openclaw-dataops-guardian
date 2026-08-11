#!/bin/sh
set -eu

guardian_root=/opt/dataops-guardian
role="${1:-}"

if [ "$#" -eq 0 ]; then
  echo "container role is required: gateway or bridge" >&2
  exit 64
fi
shift

case "$role" in
  gateway)
    ;;
  bridge)
    if [ "$#" -ne 0 ]; then
      echo "bridge role does not accept positional arguments" >&2
      exit 64
    fi
    ;;
  *)
    echo "unsupported container role: $role" >&2
    exit 64
    ;;
esac

node "$guardian_root/container/runtime-contract.mjs" preflight "$role"
cd "$guardian_root"

case "$role" in
  gateway)
    exec node /app/openclaw.mjs gateway "$@"
    ;;
  bridge)
    exec node "$guardian_root/dist/alertmanager/http-bridge/run.js"
    ;;
esac
