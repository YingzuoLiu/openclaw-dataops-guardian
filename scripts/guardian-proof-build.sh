#!/usr/bin/env bash

guardian_build_or_verify_prebuilt() {
  local stamp="${GUARDIAN_PROOF_PREBUILT_STAMP:-}"
  local plugin_dir="${GUARDIAN_PROOF_PLUGIN_DIR:-}"
  local stamped_plugin_dir
  local artifact

  if [[ -z "$stamp" ]]; then
    npm run build
    return
  fi

  if [[ ! -f "$stamp" || -z "$plugin_dir" ]]; then
    echo "prebuilt proof requires a run-owned stamp and staged plugin" >&2
    return 2
  fi
  stamped_plugin_dir="$(<"$stamp")"
  if [[ "$stamped_plugin_dir" != "$plugin_dir" ]]; then
    echo "prebuilt proof stamp does not match the staged plugin" >&2
    return 2
  fi
  for artifact in \
    "$plugin_dir/package.json" \
    "$plugin_dir/openclaw.plugin.json" \
    "$plugin_dir/dist/index.js" \
    "$@"; do
    if [[ ! -f "$artifact" ]]; then
      echo "prebuilt proof artifact is missing: $artifact" >&2
      return 2
    fi
  done
}
