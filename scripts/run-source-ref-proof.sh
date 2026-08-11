#!/usr/bin/env bash
set -Eeuo pipefail

release_ref="${1:-}"
repository_url="${2:-https://github.com/YingzuoLiu/openclaw-dataops-guardian.git}"
if [[ ! "$release_ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "source release proof requires an exact vMAJOR.MINOR.PATCH tag" >&2
  exit 2
fi

for required_command in git node npm; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "source release proof requires $required_command" >&2
    exit 1
  fi
done

runtime_dir=""
cleanup() {
  if [[ -n "$runtime_dir" && -d "$runtime_dir" &&
    "$runtime_dir" == /tmp/guardian-source-release.* ]]; then
    find "$runtime_dir" -depth -delete
  fi
}
trap cleanup EXIT

umask 077
runtime_dir="$(mktemp -d /tmp/guardian-source-release.XXXXXX)"
checkout_dir="$runtime_dir/repository"
install_log="$runtime_dir/npm-ci.log"
inspect_path="$runtime_dir/inspect.json"
lobster_inspect_path="$runtime_dir/lobster-inspect.json"
fast_demo_path="$runtime_dir/fast-demo.json"
fast_demo_log="$runtime_dir/fast-demo.log"

# A caller's normal profile must never become part of release acceptance. Set
# the proof-owned state before npm lifecycle scripts or OpenClaw run.
unset OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_HOME
export OPENCLAW_STATE_DIR="$runtime_dir/openclaw-state"
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export LOBSTER_STATE_DIR="$runtime_dir/lobster-state"
mkdir -p "$OPENCLAW_STATE_DIR" "$LOBSTER_STATE_DIR"

printf '[source-release] resolve remote tag\n' >&2
mapfile -t remote_refs < <(
  git ls-remote --tags "$repository_url" \
    "refs/tags/$release_ref" "refs/tags/$release_ref^{}"
)
if ((${#remote_refs[@]} == 0)); then
  echo "remote release tag does not exist: $release_ref" >&2
  exit 2
fi
resolved_commit=""
direct_object=""
for line in "${remote_refs[@]}"; do
  sha="${line%%[[:space:]]*}"
  ref="${line#*[[:space:]]}"
  if [[ "$ref" == "refs/tags/$release_ref^{}" ]]; then
    resolved_commit="$sha"
  elif [[ "$ref" == "refs/tags/$release_ref" ]]; then
    direct_object="$sha"
  fi
done
if [[ -z "$resolved_commit" ]]; then
  resolved_commit="$direct_object"
fi
if [[ ! "$resolved_commit" =~ ^[0-9a-f]{40}$ ]]; then
  echo "remote release tag did not resolve to a 40-hex object" >&2
  exit 2
fi

printf '[source-release] fresh shallow clone\n' >&2
git clone --quiet --depth 1 --branch "$release_ref" \
  "$repository_url" "$checkout_dir"
checkout_commit="$(git -C "$checkout_dir" rev-parse 'HEAD^{commit}')"
if [[ "$checkout_commit" != "$resolved_commit" ]]; then
  echo "fresh release checkout does not match the resolved tag commit" >&2
  exit 2
fi
if [[ -n "$(git -C "$checkout_dir" status --porcelain --untracked-files=all)" ]]; then
  echo "fresh release checkout is unexpectedly dirty" >&2
  exit 2
fi

package_version="$(
  node -p "require('$checkout_dir/package.json').version"
)"
if [[ "$release_ref" != "v$package_version" ]]; then
  echo "release tag and package version disagree" >&2
  exit 2
fi

printf '[source-release] lockfile install and build\n' >&2
set +e
(
  cd "$checkout_dir"
  npm ci --no-audit --no-fund
) >"$install_log" 2>&1
install_status=$?
set -e
if ((install_status != 0)); then
  echo "source release dependency install failed (exit $install_status)" >&2
  tail -n 120 "$install_log" >&2 || true
  exit "$install_status"
fi
set +e
(
  cd "$checkout_dir"
  npm run build
) >>"$install_log" 2>&1
build_status=$?
set -e
if ((build_status != 0)); then
  echo "source release build failed (exit $build_status)" >&2
  tail -n 120 "$install_log" >&2 || true
  exit "$build_status"
fi

printf '[source-release] runtime registration\n' >&2
openclaw_bin="$checkout_dir/node_modules/.bin/openclaw"
lobster_dir="$checkout_dir/node_modules/@openclaw/lobster"
"$openclaw_bin" plugins install --link "$checkout_dir" >/dev/null
"$openclaw_bin" plugins enable dataops-guardian >/dev/null
"$openclaw_bin" plugins install --link "$lobster_dir" >/dev/null
"$openclaw_bin" plugins enable lobster >/dev/null
batch_json="$(
  node -e '
    process.stdout.write(JSON.stringify([
      { path: "plugins.allow", value: ["dataops-guardian", "lobster"] },
      { path: "plugins.entries.dataops-guardian.enabled", value: true },
      {
        path: "plugins.entries.dataops-guardian.hooks.allowConversationAccess",
        value: true,
      },
      {
        path: "plugins.entries.dataops-guardian.config.requireToolsGateMode",
        value: "on_guardian_tool",
      },
      {
        path: "plugins.entries.dataops-guardian.config.lobsterToolPolicyMode",
        value: "incident_workflow_only",
      },
      { path: "plugins.entries.lobster.enabled", value: true },
      {
        path: "tools.allow",
        value: [
          "guardian_inspect_metric_snapshot",
          "guardian_propose_remediation",
          "guardian_query_prometheus",
          "guardian_rollback_deployment",
          "guardian_verify_deployment_recovery",
          "lobster",
        ],
      },
    ]));
  '
)"
"$openclaw_bin" config set \
  --batch-json "$batch_json" >/dev/null
"$openclaw_bin" plugins inspect \
  dataops-guardian --runtime --json >"$inspect_path"
"$openclaw_bin" plugins inspect \
  lobster --runtime --json >"$lobster_inspect_path"

printf '[source-release] live approval restart\n' >&2
set +e
(
  cd "$checkout_dir"
  bash scripts/run-final-fast-demo.sh
) >"$fast_demo_path" 2>"$fast_demo_log"
fast_demo_status=$?
set -e
if ((fast_demo_status != 0)); then
  echo "source release live approval proof failed (exit $fast_demo_status)" >&2
  tail -n 120 "$fast_demo_log" >&2 || true
  exit "$fast_demo_status"
fi

node --input-type=module - \
  "$inspect_path" "$lobster_inspect_path" "$fast_demo_path" \
  "$release_ref" "$resolved_commit" "$checkout_dir" <<'NODE'
import { readFile } from "node:fs/promises";

const [
  inspectPath,
  lobsterInspectPath,
  fastDemoPath,
  releaseRef,
  resolvedCommit,
  checkoutDir,
] = process.argv.slice(2);
const inspection = JSON.parse(await readFile(inspectPath, "utf8"));
const lobster = JSON.parse(await readFile(lobsterInspectPath, "utf8"));
const fastDemo = JSON.parse(await readFile(fastDemoPath, "utf8"));
const openclawPackage = JSON.parse(
  await readFile(`${checkoutDir}/node_modules/openclaw/package.json`, "utf8"),
);
const expectedTools = [
  "guardian_inspect_metric_snapshot",
  "guardian_propose_remediation",
  "guardian_query_prometheus",
  "guardian_rollback_deployment",
  "guardian_verify_deployment_recovery",
];
const expectedHooks = [
  "after_tool_call",
  "agent_end",
  "before_agent_finalize",
  "before_agent_run",
  "before_tool_call",
];
const tools = (inspection.tools ?? [])
  .flatMap((entry) => entry.names ?? [])
  .toSorted();
const hooks = (inspection.typedHooks ?? [])
  .map((entry) => entry.name)
  .toSorted();
if (
  JSON.stringify(tools) !== JSON.stringify(expectedTools) ||
  JSON.stringify(hooks) !== JSON.stringify(expectedHooks) ||
  (inspection.diagnostics ?? []).length !== 0 ||
  inspection.plugin?.version !== releaseRef.slice(1) ||
  openclawPackage.version !== "2026.6.34" ||
  lobster.plugin?.version !== "2026.6.34" ||
  JSON.stringify(lobster.plugin?.contracts?.tools ?? []) !==
    JSON.stringify(["lobster"]) ||
  (lobster.diagnostics ?? []).length !== 0 ||
  fastDemo.schemaVersion !== 1 ||
  fastDemo.ok !== true ||
  fastDemo.proof !== "dataops-guardian-fast-demo" ||
  fastDemo.source?.commit !== resolvedCommit ||
  fastDemo.components?.syntheticApproval !== true ||
  fastDemo.components?.syntheticDenial !== true
) {
  throw new Error("source release runtime or approval contract failed");
}
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    proof: "dataops-guardian-source-release",
    releaseRef,
    sourceRevision: resolvedCommit,
    guardianVersion: inspection.plugin.version,
    openclawVersion: openclawPackage.version,
    lobsterVersion: lobster.plugin.version,
    runtimeRegistration: {
      tools: tools.length,
      hooks: hooks.length,
      lobsterApprovalRestart: true,
    },
  })}\n`,
);
NODE
