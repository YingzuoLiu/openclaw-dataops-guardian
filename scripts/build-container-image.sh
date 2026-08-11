#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$ROOT_DIR/scripts/guardian-proof-native-stage.sh"

guardian_require_proof_source_commit "$ROOT_DIR"
source_commit="$GUARDIAN_PROOF_SOURCE_COMMIT"

for required_command in docker git node tar; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "container image build requires $required_command" >&2
    exit 1
  fi
done

guardian_version="$({
  git -C "$ROOT_DIR" show "$source_commit:package.json"
} | node -e '
  let source = "";
  process.stdin.on("data", (chunk) => { source += chunk; });
  process.stdin.on("end", () => {
    const version = JSON.parse(source).version;
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw new Error("package version must be an exact semantic version");
    }
    process.stdout.write(version);
  });
')"

image_ref="${1:-openclaw-dataops-guardian:${guardian_version}-${source_commit:0:12}}"
if [[ -z "$image_ref" || "$image_ref" =~ [[:space:]] ]]; then
  echo "container image reference must be non-empty and contain no whitespace" >&2
  exit 2
fi

stage_root=""
cleanup() {
  if [[ -n "$stage_root" && -d "$stage_root" &&
    "$stage_root" == /tmp/guardian-container-build.* ]]; then
    find "$stage_root" -depth -delete
  fi
}
trap cleanup EXIT

umask 077
stage_root="$(mktemp -d /tmp/guardian-container-build.XXXXXX)"
context_dir="$stage_root/context"
mkdir -p "$context_dir"

# Archive the already-validated commit object, not the live worktree. This
# closes the gap between a clean-tree check and Docker reading its context and
# ensures ignored host dist/node_modules content can never become release input.
git -C "$ROOT_DIR" archive --format=tar "$source_commit" |
  tar -xf - -C "$context_dir"

for required_path in \
  .dockerignore \
  container/Dockerfile \
  container/package-lock.json \
  container/runtime-contract.mjs \
  package-lock.json \
  src/index.ts; do
  if [[ ! -f "$context_dir/$required_path" ]]; then
    echo "exact-commit container context is missing: $required_path" >&2
    exit 2
  fi
done
for forbidden_path in .git node_modules dist dist-runtime .env; do
  if [[ -e "$context_dir/$forbidden_path" ]]; then
    echo "exact-commit container context contains forbidden path: $forbidden_path" >&2
    exit 2
  fi
done

docker build \
  --pull \
  --platform linux/amd64 \
  --file "$context_dir/container/Dockerfile" \
  --build-arg "GUARDIAN_SOURCE_REVISION=$source_commit" \
  --build-arg "GUARDIAN_VERSION=$guardian_version" \
  --tag "$image_ref" \
  "$context_dir"

node -e '
  process.stdout.write(`${JSON.stringify({
    ok: true,
    image: process.argv[1],
    guardianVersion: process.argv[2],
    sourceRevision: process.argv[3],
  })}\n`);
' "$image_ref" "$guardian_version" "$source_commit"
