#!/usr/bin/env bash

guardian_proof_needs_native_stage() {
  local root_dir="$1"
  local filesystem_type

  if [[ "${GUARDIAN_PROOF_NATIVE_STAGED:-0}" == "1" ]]; then
    return 1
  fi
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

# DrvFS is correct for source storage but imposes a large per-file cost on
# OpenClaw's ESM graph. Re-run the proof from a private Linux-filesystem mirror
# so the exact checkout and installed dependencies are read with native WSL
# semantics. The mirror contains only non-ignored worktree files plus the
# existing node_modules tree and is deleted when the child proof exits.
guardian_reexec_proof_on_native_fs() {
  local root_dir="$1"
  local entry_script="$2"
  local progress_label="$3"
  local progress_fd="${GUARDIAN_FINAL_PROGRESS_FD:-2}"
  shift 3

  if ! guardian_proof_needs_native_stage "$root_dir"; then
    return 0
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "native proof staging requires git" >&2
    exit 1
  fi
  if ! command -v tar >/dev/null 2>&1; then
    echo "native proof staging requires tar" >&2
    exit 1
  fi
  if [[ ! -d "$root_dir/node_modules" ]]; then
    echo "native proof staging requires the installed node_modules tree" >&2
    exit 1
  fi

  local stage_status
  set +e
  (
    set -euo pipefail
    local stage_root
    local staged_repo
    local staged_tmp
    local copy_status
    local child_status
    local -a copy_command

    stage_root="$(mktemp -d /tmp/guardian-proof-native.XXXXXX)"
    staged_repo="$stage_root/repo"
    staged_tmp="$stage_root/tmp"
    mkdir -p "$staged_repo" "$staged_tmp"

    cleanup_native_stage() {
      if [[ -d "$stage_root" && "$stage_root" == /tmp/guardian-proof-native.* ]]; then
        find "$stage_root" -depth -delete
      fi
    }
    trap cleanup_native_stage EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM

    printf '[%s] native WSL staging\n' "$progress_label" >&"$progress_fd"
    copy_command=(
      bash -c '
        set -euo pipefail
        source_root="$1"
        destination_root="$2"
        {
          git -C "$source_root" ls-files \
            --cached --others --exclude-standard -z
          printf "node_modules\0"
        } | tar \
          --directory="$source_root" \
          --create --file=- --null --files-from=- \
          | (umask 077; tar \
              --directory="$destination_root" \
              --extract --file=- \
              --no-same-owner --no-same-permissions)
      ' guardian-proof-native-stage "$root_dir" "$staged_repo"
    )
    set +e
    if command -v timeout >/dev/null 2>&1; then
      timeout --signal=TERM --kill-after=30s \
        "${GUARDIAN_PROOF_NATIVE_STAGE_TIMEOUT:-600s}" \
        "${copy_command[@]}"
      copy_status=$?
    else
      "${copy_command[@]}"
      copy_status=$?
    fi
    set -e
    if ((copy_status != 0)); then
      echo "native proof staging failed (exit ${copy_status})" >&2
      exit "$copy_status"
    fi
    if [[ ! -f "$staged_repo/$entry_script" ]]; then
      echo "native proof staging omitted entry script: $entry_script" >&2
      exit 2
    fi

    printf '[%s] native WSL staging complete\n' "$progress_label" >&"$progress_fd"
    set +e
    (
      cd "$staged_repo"
      TMPDIR="$staged_tmp" \
      GUARDIAN_PROOF_NATIVE_STAGED=1 \
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
