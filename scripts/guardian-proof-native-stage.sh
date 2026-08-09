#!/usr/bin/env bash

guardian_proof_needs_native_stage() {
  local root_dir="$1"
  local filesystem_type

  if [[ "${GUARDIAN_PROOF_FORCE_NATIVE_STAGE:-0}" == "1" ]]; then
    return 0
  fi

  filesystem_type="$(stat -f -c %T "$root_dir" 2>/dev/null || true)"
  case "$filesystem_type" in
    9p | drvfs | fuseblk)
      return 0
      ;;
  esac
  case "$root_dir/" in
    /mnt/[A-Za-z]/*)
      return 0
      ;;
  esac
  return 1
}

guardian_require_proof_source_commit() {
  local root_dir="$1"
  local canonical_root
  local git_root
  local source_commit
  local worktree_status

  if ! command -v git >/dev/null 2>&1; then
    echo "proof source validation requires git" >&2
    return 1
  fi
  if ! canonical_root="$(cd "$root_dir" 2>/dev/null && pwd -P)"; then
    echo "proof source root is unavailable: $root_dir" >&2
    return 1
  fi
  if ! git_root="$(git -C "$canonical_root" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "proof source must be a committed git worktree" >&2
    return 1
  fi
  if ! git_root="$(cd "$git_root" 2>/dev/null && pwd -P)"; then
    echo "proof source git root is unavailable" >&2
    return 1
  fi
  if [[ "$canonical_root" != "$git_root" ]]; then
    echo "proof source root must be the git worktree root" >&2
    return 1
  fi
  if ! source_commit="$(git -C "$canonical_root" rev-parse --verify 'HEAD^{commit}' 2>/dev/null)" ||
    [[ ! "$source_commit" =~ ^[0-9a-f]{40}$ ]]; then
    echo "proof source must have a committed 40-hex HEAD" >&2
    return 1
  fi
  if ! worktree_status="$(
    git -C "$canonical_root" status \
      --porcelain=v1 --untracked-files=all --ignore-submodules=none
  )"; then
    echo "proof source worktree status could not be read" >&2
    return 1
  fi
  if [[ -n "$worktree_status" ]]; then
    echo "proof source worktree must be clean before execution" >&2
    return 2
  fi
  if [[ -n "${GUARDIAN_PROOF_SOURCE_COMMIT:-}" ]]; then
    if [[ ! "$GUARDIAN_PROOF_SOURCE_COMMIT" =~ ^[0-9a-f]{40}$ ]]; then
      echo "inherited proof source commit must be a valid 40-hex commit" >&2
      return 2
    fi
    if [[ "$GUARDIAN_PROOF_SOURCE_COMMIT" != "$source_commit" ]]; then
      echo "inherited proof source commit does not match checked-out HEAD" >&2
      return 2
    fi
  fi

  GUARDIAN_PROOF_SOURCE_COMMIT="$source_commit"
  export GUARDIAN_PROOF_SOURCE_COMMIT
}

# DrvFS is correct for source storage but imposes a large per-file cost on
# OpenClaw's ESM graph. Re-run the proof from a private Linux-filesystem mirror
# so the exact committed checkout and a lockfile-installed dependency tree are
# read with native WSL semantics. No source node_modules content enters the
# mirror, and the private capsule is deleted when the child proof exits.
guardian_reexec_proof_on_native_fs() {
  local root_dir="$1"
  local entry_script="$2"
  local progress_label="$3"
  local progress_fd="${GUARDIAN_FINAL_PROGRESS_FD:-2}"
  shift 3

  if ! guardian_proof_needs_native_stage "$root_dir"; then
    return 0
  fi
  guardian_require_proof_source_commit "$root_dir" || exit "$?"
  local source_commit="$GUARDIAN_PROOF_SOURCE_COMMIT"

  if ! command -v npm >/dev/null 2>&1; then
    echo "native proof staging requires npm" >&2
    exit 1
  fi
  if [[ ! -f "$root_dir/package-lock.json" ]]; then
    echo "native proof staging requires package-lock.json" >&2
    exit 1
  fi

  local stage_status
  set +e
  (
    set -euo pipefail
    local stage_root=""
    local staged_repo
    local staged_tmp
    local checkout_status
    local install_log
    local install_status
    local child_status
    local -a checkout_command
    local -a install_command

    cleanup_native_stage() {
      if [[ -n "$stage_root" && -d "$stage_root" &&
        "$stage_root" == /tmp/guardian-proof-native.* ]]; then
        find "$stage_root" -depth -delete
      fi
    }
    trap cleanup_native_stage EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    umask 077
    stage_root="$(mktemp -d /tmp/guardian-proof-native.XXXXXX)"
    staged_repo="$stage_root/repo"
    staged_tmp="$stage_root/tmp"
    install_log="$stage_root/npm-ci.log"
    mkdir -p "$staged_tmp"

    printf '[%s] native WSL staging\n' "$progress_label" >&"$progress_fd"
    checkout_command=(
      bash -c '
        set -euo pipefail
        source_root="$1"
        source_commit="$2"
        destination_root="$3"
        git init --quiet --template= "$destination_root"
        git -C "$destination_root" fetch \
          --quiet --depth=1 --no-tags "$source_root" "$source_commit"
        git -C "$destination_root" \
          -c advice.detachedHead=false -c core.hooksPath=/dev/null \
          checkout --quiet --detach FETCH_HEAD
        test "$(git -C "$destination_root" rev-parse HEAD)" = "$source_commit"
      ' guardian-proof-native-stage \
        "$root_dir" "$source_commit" "$staged_repo"
    )
    set +e
    if command -v timeout >/dev/null 2>&1; then
      timeout --signal=TERM --kill-after=30s \
        "${GUARDIAN_PROOF_NATIVE_STAGE_TIMEOUT:-600s}" \
        "${checkout_command[@]}"
      checkout_status=$?
    else
      "${checkout_command[@]}"
      checkout_status=$?
    fi
    set -e
    if ((checkout_status != 0)); then
      echo "native proof exact-commit checkout failed (exit ${checkout_status})" >&2
      exit "$checkout_status"
    fi
    if [[ ! -f "$staged_repo/$entry_script" ]]; then
      echo "native proof staging omitted entry script: $entry_script" >&2
      exit 2
    fi
    if [[ ! -f "$staged_repo/package-lock.json" ]]; then
      echo "native proof exact-commit checkout omitted package-lock.json" >&2
      exit 2
    fi
    if find "$staged_repo" -type d -name node_modules -print -quit | grep -q .; then
      echo "native proof exact-commit checkout unexpectedly contained node_modules" >&2
      exit 2
    fi

    printf '[%s] native WSL dependency install\n' \
      "$progress_label" >&"$progress_fd"
    install_command=(
      npm ci --ignore-scripts --no-audit --no-fund --prefer-offline
    )
    set +e
    if command -v timeout >/dev/null 2>&1; then
      (
        cd "$staged_repo"
        timeout --signal=TERM --kill-after=30s \
          "${GUARDIAN_PROOF_NATIVE_INSTALL_TIMEOUT:-600s}" \
          "${install_command[@]}"
      ) >"$install_log" 2>&1
      install_status=$?
    else
      (
        cd "$staged_repo"
        "${install_command[@]}"
      ) >"$install_log" 2>&1
      install_status=$?
    fi
    set -e
    if ((install_status != 0)); then
      echo "native proof dependency install failed (exit ${install_status})" >&2
      echo "last dependency install diagnostic lines:" >&2
      tail -n 120 "$install_log" >&2 || true
      exit "$install_status"
    fi

    printf '[%s] native WSL staging complete\n' \
      "$progress_label" >&"$progress_fd"
    set +e
    (
      cd "$staged_repo"
      TMPDIR="$staged_tmp" \
      GUARDIAN_PROOF_NATIVE_STAGED=1 \
      GUARDIAN_PROOF_FORCE_NATIVE_STAGE=0 \
      GUARDIAN_PROOF_SOURCE_COMMIT="$source_commit" \
        bash "$entry_script" "$@"
    )
    child_status=$?
    set -e
    exit "$child_status"
  )
  stage_status=$?
  set -e
  exit "$stage_status"
}
