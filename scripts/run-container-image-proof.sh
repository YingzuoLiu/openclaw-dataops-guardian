#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source "$ROOT_DIR/scripts/guardian-proof-native-stage.sh"
guardian_require_proof_source_commit "$ROOT_DIR"
source_commit="$GUARDIAN_PROOF_SOURCE_COMMIT"

for required_command in docker git node timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "container image proof requires $required_command" >&2
    exit 1
  fi
done
docker info >/dev/null

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

runtime_dir=""
gateway_container=""
bridge_container=""
network_name=""
gateway_volume=""
bridge_volume=""
corrupt_volume=""
image_ref=""
host_sentinel_path=""
host_sentinel=""
negative_containers=()

cleanup_docker_resources() {
  local failed=0
  # A negative Bridge may hold the Gateway container's network namespace.
  # Remove dependents first so cleanup can always delete the namespace owner.
  for container in "${negative_containers[@]}" "$bridge_container" \
    "$gateway_container"; do
    if [[ -n "$container" ]] &&
      docker container inspect "$container" >/dev/null 2>&1; then
      docker rm -f "$container" >/dev/null 2>&1 || failed=1
    fi
  done
  if [[ -n "$network_name" ]] &&
    docker network inspect "$network_name" >/dev/null 2>&1; then
    docker network rm "$network_name" >/dev/null 2>&1 || failed=1
  fi
  for volume in "$gateway_volume" "$bridge_volume" "$corrupt_volume"; do
    if [[ -n "$volume" ]] && docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume rm -f "$volume" >/dev/null 2>&1 || failed=1
    fi
  done
  if [[ -n "$image_ref" ]] && docker image inspect "$image_ref" >/dev/null 2>&1; then
    docker image rm -f "$image_ref" >/dev/null 2>&1 || failed=1
  fi
  return "$failed"
}

remove_owned_host_sentinel() {
  if [[ -z "$host_sentinel_path" || ! -e "$host_sentinel_path" ]]; then
    return 0
  fi
  if [[ ! -f "$host_sentinel_path" ]] ||
    [[ "$(<"$host_sentinel_path")" != "$host_sentinel" ]]; then
    echo "refusing to remove a changed host sentinel: $host_sentinel_path" >&2
    return 1
  fi
  rm -f -- "$host_sentinel_path"
}

cleanup() {
  cleanup_docker_resources || true
  remove_owned_host_sentinel || true
  if [[ -n "$runtime_dir" && -d "$runtime_dir" &&
    "$runtime_dir" == /tmp/guardian-container-proof.* ]]; then
    find "$runtime_dir" -depth -delete
  fi
}
trap cleanup EXIT

umask 077
runtime_dir="$(mktemp -d /tmp/guardian-container-proof.XXXXXX)"
run_token="${runtime_dir##*.}"
gateway_container="guardian-image-gateway-${source_commit:0:8}-${run_token}"
bridge_container="guardian-image-bridge-${source_commit:0:8}-${run_token}"
network_name="guardian-image-proof-${source_commit:0:8}-${run_token}"
gateway_volume="guardian-image-gateway-${source_commit:0:8}-${run_token}"
bridge_volume="guardian-image-bridge-${source_commit:0:8}-${run_token}"
corrupt_volume="guardian-image-corrupt-${source_commit:0:8}-${run_token}"
image_ref="guardian-image-proof:${source_commit:0:8}-${run_token}"
host_sentinel_path="$ROOT_DIR/dist/guardian-host-dist-must-not-enter-image-${run_token}"
host_sentinel="guardian-host-dist-sentinel-${source_commit}-${run_token}"

for container in "$gateway_container" "$bridge_container"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "container image proof target already exists: $container" >&2
    exit 1
  fi
done
if docker network inspect "$network_name" >/dev/null 2>&1; then
  echo "container image proof network already exists: $network_name" >&2
  exit 1
fi
for volume in "$gateway_volume" "$bridge_volume" "$corrupt_volume"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "container image proof volume already exists: $volume" >&2
    exit 1
  fi
done
if docker image inspect "$image_ref" >/dev/null 2>&1; then
  echo "container image proof tag already exists: $image_ref" >&2
  exit 1
fi
if [[ -e "$host_sentinel_path" ]]; then
  echo "container image proof sentinel target already exists: $host_sentinel_path" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/dist" "$runtime_dir/empty-dist" \
  "$runtime_dir/read-only-state"
chmod 0555 "$runtime_dir/empty-dist"
chmod 0555 "$runtime_dir/read-only-state"
printf '%s\n' "$host_sentinel" >"$host_sentinel_path"

unknown_role_passed=false
missing_artifact_passed=false
missing_gateway_environment_passed=false
missing_bridge_environment_passed=false
corrupt_bridge_state_passed=false
host_dist_excluded_passed=false
lobster_approval_restart_passed=false
arbitrary_lobster_blocked_passed=false
unwritable_bridge_state_passed=false
reused_bridge_credentials_passed=false

printf '[container] exact-commit build\n' >&2
set +e
bash "$ROOT_DIR/scripts/build-container-image.sh" "$image_ref" \
  >"$runtime_dir/build.log"
build_status=$?
set -e
if ((build_status != 0)); then
  echo "container exact-commit build failed (exit $build_status)" >&2
  tail -n 120 "$runtime_dir/build.log" >&2 || true
  exit "$build_status"
fi

docker image inspect "$image_ref" >"$runtime_dir/image-inspect.json"
docker run --rm --network none --entrypoint node "$image_ref" \
  /opt/dataops-guardian/container/runtime-contract.mjs report \
  >"$runtime_dir/runtime-report.json"
docker run --rm --network none --entrypoint node "$image_ref" --version \
  >"$runtime_dir/node-version.txt"

node --input-type=module - \
  "$runtime_dir/image-inspect.json" \
  "$runtime_dir/runtime-report.json" \
  "$runtime_dir/node-version.txt" \
  "$source_commit" \
  "$guardian_version" <<'NODE'
import { readFile } from "node:fs/promises";

const [inspectPath, reportPath, nodeVersionPath, sourceCommit, guardianVersion] =
  process.argv.slice(2);
const [inspection] = JSON.parse(await readFile(inspectPath, "utf8"));
const report = JSON.parse(await readFile(reportPath, "utf8"));
const nodeVersion = (await readFile(nodeVersionPath, "utf8")).trim();
const healthcheck = inspection.Config?.Healthcheck;
const healthcheckDisabled =
  healthcheck == null || healthcheck.Test?.[0] === "NONE";
const labels = inspection.Config?.Labels ?? {};
if (
  inspection.Config?.User !== "node" ||
  inspection.Config?.WorkingDir !== "/opt/dataops-guardian" ||
  JSON.stringify(inspection.Config?.Entrypoint) !==
    JSON.stringify([
      "tini",
      "-s",
      "--",
      "/opt/dataops-guardian/container/entrypoint.sh",
    ]) ||
  JSON.stringify(inspection.Config?.Cmd) !== JSON.stringify(["gateway"]) ||
  !healthcheckDisabled ||
  labels["org.opencontainers.image.revision"] !== sourceCommit ||
  labels["org.opencontainers.image.version"] !== guardianVersion ||
  labels["io.openclaw.version"] !== "2026.6.34" ||
  labels["io.openclaw.node-version"] !== "24.16.0" ||
  labels["io.openclaw.guardian.roles"] !== "gateway,bridge" ||
  report.ok !== true ||
  report.uid !== 1000 ||
  report.metadata?.sourceRevision !== sourceCommit ||
  report.metadata?.guardianVersion !== guardianVersion ||
  report.metadata?.openclaw?.version !== "2026.6.34" ||
  report.metadata?.lobsterVersion !== "2026.6.34" ||
  report.metadata?.nodeVersion !== "24.16.0" ||
  !Number.isInteger(report.immutableRuntime?.entryCount) ||
  report.immutableRuntime.entryCount < 1 ||
  nodeVersion !== "v24.16.0"
) {
  throw new Error("container image metadata contract failed");
}
NODE

printf '[container] negative startup contracts\n' >&2
unknown_container="guardian-image-unknown-${source_commit:0:8}-${run_token}"
if docker container inspect "$unknown_container" >/dev/null 2>&1; then
  echo "container image proof target already exists: $unknown_container" >&2
  exit 1
fi
negative_containers+=("$unknown_container")
set +e
timeout --foreground --signal=TERM --kill-after=5s 15s \
  docker run --rm --name "$unknown_container" \
  --network none "$image_ref" unsupported \
  >"$runtime_dir/unknown-role.out" 2>"$runtime_dir/unknown-role.err"
unknown_status=$?
set -e
if ((unknown_status == 0 || unknown_status == 124 || unknown_status == 137)) ||
  ! grep -q "unsupported container role" "$runtime_dir/unknown-role.err"; then
  echo "unknown container role did not fail closed" >&2
  exit 1
fi
unknown_role_passed=true

set +e
missing_artifact_container="guardian-image-artifact-${source_commit:0:8}-${run_token}"
if docker container inspect "$missing_artifact_container" >/dev/null 2>&1; then
  echo "container image proof target already exists: $missing_artifact_container" >&2
  exit 1
fi
negative_containers+=("$missing_artifact_container")
timeout --foreground --signal=TERM --kill-after=5s 15s docker run --rm \
  --name "$missing_artifact_container" --network none \
  --mount "type=bind,source=$runtime_dir/empty-dist,destination=/opt/dataops-guardian/dist,readonly" \
  "$image_ref" gateway \
  >"$runtime_dir/missing-artifact.out" 2>"$runtime_dir/missing-artifact.err"
missing_artifact_status=$?
set -e
if ((missing_artifact_status == 0 || missing_artifact_status == 124 || missing_artifact_status == 137)) ||
  ! grep -q "missing Guardian artifact" "$runtime_dir/missing-artifact.err"; then
  echo "missing image artifact did not fail closed" >&2
  exit 1
fi
missing_artifact_passed=true

gateway_required=(
  OPENCLAW_CONFIG_PATH
  OPENCLAW_GATEWAY_TOKEN
  OPENCLAW_STATE_DIR
  LOBSTER_STATE_DIR
)
for missing in "${gateway_required[@]}"; do
  filtered_args=(--rm --network none --tmpfs /tmp)
  for name in "${gateway_required[@]}"; do
    if [[ "$name" == "$missing" ]]; then
      continue
    fi
    case "$name" in
      OPENCLAW_CONFIG_PATH)
        value=/opt/dataops-guardian/container/openclaw.container.example.json
        ;;
      OPENCLAW_GATEWAY_TOKEN)
        value=proof-gateway-token
        ;;
      OPENCLAW_STATE_DIR)
        value=/tmp/openclaw-state
        ;;
      LOBSTER_STATE_DIR)
        value=/tmp/lobster-state
        ;;
    esac
    filtered_args+=(-e "$name=$value")
  done
  missing_container="guardian-image-missing-gateway-${missing,,}-${source_commit:0:8}-${run_token}"
  if docker container inspect "$missing_container" >/dev/null 2>&1; then
    echo "container image proof target already exists: $missing_container" >&2
    exit 1
  fi
  negative_containers+=("$missing_container")
  set +e
  timeout --foreground --signal=TERM --kill-after=5s 15s \
    docker run --name "$missing_container" \
    "${filtered_args[@]}" "$image_ref" gateway \
    >"$runtime_dir/missing-gateway-$missing.out" \
    2>"$runtime_dir/missing-gateway-$missing.err"
  missing_status=$?
  set -e
  if ((missing_status == 0 || missing_status == 124 || missing_status == 137)) ||
    ! grep -q "$missing is required" \
      "$runtime_dir/missing-gateway-$missing.err"; then
    echo "Gateway missing-env contract failed for $missing" >&2
    exit 1
  fi
done
missing_gateway_environment_passed=true

bridge_required=(
  ALERTMANAGER_BRIDGE_TOKEN
  OPENCLAW_GATEWAY_URL
  OPENCLAW_GATEWAY_TOKEN
  ALERTMANAGER_BRIDGE_STATE_DIR
)
for missing in "${bridge_required[@]}"; do
  # Rebuild the env list explicitly so the missing variable can never be
  # inherited or accidentally retained.
  filtered_args=(--rm --network none --tmpfs /tmp)
  for name in "${bridge_required[@]}"; do
    if [[ "$name" == "$missing" ]]; then
      continue
    fi
    case "$name" in
      ALERTMANAGER_BRIDGE_TOKEN)
        value=proof-alert-token
        ;;
      OPENCLAW_GATEWAY_URL)
        value=ws://127.0.0.1:1
        ;;
      OPENCLAW_GATEWAY_TOKEN)
        value=proof-gateway-token
        ;;
      ALERTMANAGER_BRIDGE_STATE_DIR)
        value=/tmp/bridge-state
        ;;
    esac
    filtered_args+=(-e "$name=$value")
  done
  missing_container="guardian-image-missing-${missing,,}-${source_commit:0:8}-${run_token}"
  if docker container inspect "$missing_container" >/dev/null 2>&1; then
    echo "container image proof target already exists: $missing_container" >&2
    exit 1
  fi
  negative_containers+=("$missing_container")
  set +e
  timeout --foreground --signal=TERM --kill-after=5s 15s \
    docker run --name "$missing_container" \
    "${filtered_args[@]}" "$image_ref" bridge \
    >"$runtime_dir/missing-$missing.out" \
    2>"$runtime_dir/missing-$missing.err"
  missing_status=$?
  set -e
  if ((missing_status == 0 || missing_status == 124 || missing_status == 137)) ||
    ! grep -q "$missing is required" "$runtime_dir/missing-$missing.err"; then
    echo "Bridge missing-env contract failed for $missing" >&2
    exit 1
  fi
done
missing_bridge_environment_passed=true

readonly_state_container="guardian-image-readonly-state-${source_commit:0:8}-${run_token}"
if docker container inspect "$readonly_state_container" >/dev/null 2>&1; then
  echo "container image proof target already exists: $readonly_state_container" >&2
  exit 1
fi
negative_containers+=("$readonly_state_container")
set +e
timeout --foreground --signal=TERM --kill-after=5s 15s \
  docker run --rm --name "$readonly_state_container" --network none \
  -e "ALERTMANAGER_BRIDGE_TOKEN=proof-alert-token" \
  -e "OPENCLAW_GATEWAY_URL=ws://127.0.0.1:1" \
  -e "OPENCLAW_GATEWAY_TOKEN=proof-gateway-token" \
  -e "ALERTMANAGER_BRIDGE_STATE_DIR=/var/lib/dataops-guardian" \
  --mount "type=bind,source=$runtime_dir/read-only-state,destination=/var/lib/dataops-guardian,readonly" \
  "$image_ref" bridge \
  >"$runtime_dir/read-only-state.out" 2>"$runtime_dir/read-only-state.err"
readonly_state_status=$?
set -e
if ((readonly_state_status == 0 || readonly_state_status == 124 || readonly_state_status == 137)) ||
  ! grep -Eiq "EACCES|EROFS|permission denied|read-only file system" \
    "$runtime_dir/read-only-state.err" ||
  grep -Eq "ECONNREFUSED|alertmanager http bridge listening" \
    "$runtime_dir/read-only-state.out" "$runtime_dir/read-only-state.err"; then
  echo "read-only Bridge state did not fail before Gateway connection" >&2
  exit 1
fi
unwritable_bridge_state_passed=true

reused_credentials_container="guardian-image-reused-creds-${source_commit:0:8}-${run_token}"
if docker container inspect "$reused_credentials_container" >/dev/null 2>&1; then
  echo "container image proof target already exists: $reused_credentials_container" >&2
  exit 1
fi
negative_containers+=("$reused_credentials_container")
set +e
timeout --foreground --signal=TERM --kill-after=5s 15s \
  docker run --rm --name "$reused_credentials_container" --network none \
  --tmpfs /tmp \
  -e "ALERTMANAGER_BRIDGE_TOKEN=reused-proof-token" \
  -e "OPENCLAW_GATEWAY_URL=ws://127.0.0.1:1" \
  -e "OPENCLAW_GATEWAY_TOKEN=reused-proof-token" \
  -e "ALERTMANAGER_BRIDGE_STATE_DIR=/tmp/bridge-state" \
  "$image_ref" bridge \
  >"$runtime_dir/reused-creds.out" 2>"$runtime_dir/reused-creds.err"
reused_credentials_status=$?
set -e
if ((reused_credentials_status == 0 || reused_credentials_status == 124 || reused_credentials_status == 137)) ||
  ! grep -q "must be distinct" "$runtime_dir/reused-creds.err" ||
  grep -Eq "ECONNREFUSED|alertmanager http bridge listening" \
    "$runtime_dir/reused-creds.out" "$runtime_dir/reused-creds.err"; then
  echo "reused Bridge credentials did not fail before Gateway connection" >&2
  exit 1
fi
reused_bridge_credentials_passed=true

printf '[container] live Gateway and Bridge roles\n' >&2
docker network create "$network_name" >/dev/null
docker volume create "$gateway_volume" >/dev/null
docker volume create "$bridge_volume" >/dev/null
gateway_token="guardian-container-proof-gateway-token"
alert_token="guardian-container-proof-alert-token"

start_gateway() {
  docker run -d \
    --name "$gateway_container" \
    --network "$network_name" \
    --network-alias gateway \
    -e "OPENCLAW_CONFIG_PATH=/opt/dataops-guardian/container/openclaw.container.example.json" \
    -e "OPENCLAW_GATEWAY_TOKEN=$gateway_token" \
    -e "OPENCLAW_STATE_DIR=/home/node/.openclaw" \
    -e "LOBSTER_STATE_DIR=/home/node/.openclaw/lobster-state" \
    -e "OPENCLAW_DISABLE_BUNDLED_PLUGINS=1" \
    --mount "type=volume,source=$gateway_volume,destination=/home/node/.openclaw" \
    "$image_ref" gateway run \
      --port 18789 --bind lan --auth token --allow-unconfigured \
    >/dev/null
}

wait_for_gateway() {
  local gateway_ready=false
  for _ in $(seq 1 120); do
    if docker exec "$gateway_container" node -e \
      "Promise.all([fetch('http://127.0.0.1:18789/healthz'),fetch('http://127.0.0.1:18789/readyz')]).then(r=>process.exit(r.every(x=>x.ok)?0:1)).catch(()=>process.exit(1))"; then
      gateway_ready=true
      break
    fi
    if ! docker inspect -f '{{.State.Running}}' "$gateway_container" 2>/dev/null |
      grep -qx true; then
      break
    fi
    sleep 0.5
  done
  if [[ "$gateway_ready" != true ]]; then
    docker logs "$gateway_container" >"$runtime_dir/gateway.log" 2>&1 || true
    tail -n 120 "$runtime_dir/gateway.log" >&2 || true
    echo "container Gateway did not become ready" >&2
    return 1
  fi
}

start_gateway
wait_for_gateway

docker exec "$gateway_container" node /app/openclaw.mjs \
  plugins inspect dataops-guardian --runtime --json \
  >"$runtime_dir/guardian-inspect.json"
docker exec "$gateway_container" node /app/openclaw.mjs \
  plugins inspect lobster --runtime --json \
  >"$runtime_dir/lobster-inspect.json"
docker exec -i "$gateway_container" node --input-type=module - \
  >"$runtime_dir/gateway-runtime.json" <<'NODE'
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const client = new GatewayClient({
  url: "ws://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  clientName: "gateway-client",
  clientDisplayName: "dataops-guardian-container-proof",
  clientVersion: "2026.6.34",
  platform: process.platform,
  mode: "backend",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 20_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});

try {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Gateway proof client timeout")), 15_000),
    ),
  ]);
  const catalog = await client.request("tools.catalog", {
    agentId: "main",
    includePlugins: true,
  });
  const arbitrary = await client.request("tools.invoke", {
    name: "lobster",
    args: {
      action: "run",
      pipeline: "exec --shell 'printenv OPENCLAW_GATEWAY_TOKEN'",
      cwd: ".",
      timeoutMs: 15_000,
    },
  });
  const run = await client.request("tools.invoke", {
    name: "lobster",
    args: {
      action: "run",
      pipeline: "workflows/incident-remediation.lobster",
      argsJson: JSON.stringify({
        alert_id: "container-restart-proof",
        metric: "kubernetes_deployment_revision",
        action: "rollback_latest_release",
      }),
      cwd: ".",
      timeoutMs: 15_000,
    },
  });
  process.stdout.write(`${JSON.stringify({ catalog, arbitrary, run })}\n`);
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
NODE

node --input-type=module - \
  "$runtime_dir/guardian-inspect.json" \
  "$runtime_dir/lobster-inspect.json" \
  "$runtime_dir/gateway-runtime.json" \
  "$guardian_version" <<'NODE'
import { readFile } from "node:fs/promises";

const [guardianPath, lobsterPath, runtimePath, guardianVersion] =
  process.argv.slice(2);
const guardian = JSON.parse(await readFile(guardianPath, "utf8"));
const lobster = JSON.parse(await readFile(lobsterPath, "utf8"));
const { catalog } = JSON.parse(await readFile(runtimePath, "utf8"));
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
const tools = (guardian.tools ?? []).flatMap((entry) => entry.names ?? []).toSorted();
const hooks = (guardian.typedHooks ?? []).map((entry) => entry.name).toSorted();
const lobsterContractTools = lobster.plugin?.contracts?.tools ?? [];
const lobsterFactories = lobster.tools ?? [];
const lobsterCatalogGroup = (catalog.groups ?? []).find(
  (group) =>
    group.id === "plugin:lobster" &&
    group.source === "plugin" &&
    group.pluginId === "lobster",
);
const lobsterCatalogTools = lobsterCatalogGroup?.tools ?? [];
if (
  JSON.stringify(tools) !== JSON.stringify(expectedTools) ||
  JSON.stringify(hooks) !== JSON.stringify(expectedHooks) ||
  (guardian.diagnostics ?? []).length !== 0 ||
  guardian.plugin?.rootDir !== "/opt/dataops-guardian" ||
  guardian.plugin?.version !== guardianVersion ||
  JSON.stringify(lobsterContractTools) !== JSON.stringify(["lobster"]) ||
  lobsterFactories.length !== 1 ||
  lobsterFactories[0]?.optional !== true ||
  catalog.agentId !== "main" ||
  !lobsterCatalogTools.some(
    (tool) =>
      tool.id === "lobster" &&
      tool.source === "plugin" &&
      tool.pluginId === "lobster" &&
      tool.optional === true &&
      tool.label === "Lobster Workflow" &&
      typeof tool.description === "string" &&
      tool.description.startsWith("Run Lobster pipelines"),
  ) ||
  (lobster.diagnostics ?? []).length !== 0 ||
  lobster.plugin?.rootDir !==
    "/opt/dataops-guardian/node_modules/@openclaw/lobster" ||
  lobster.plugin?.version !== "2026.6.34"
) {
  throw new Error("container plugin runtime registration failed");
}
NODE

node --input-type=module - \
  "$runtime_dir/gateway-runtime.json" "$gateway_token" <<'NODE'
import { readFile } from "node:fs/promises";

const [path, gatewayToken] = process.argv.slice(2);
const { arbitrary: invocation } = JSON.parse(await readFile(path, "utf8"));
if (
  invocation.ok !== false ||
  invocation.toolName !== "lobster" ||
  invocation.error?.code !== "forbidden" ||
  JSON.stringify(invocation).includes(gatewayToken)
) {
  throw new Error("arbitrary Lobster shell pipeline was not blocked");
}
NODE
arbitrary_lobster_blocked_passed=true

node --input-type=module - \
  "$runtime_dir/gateway-runtime.json" \
  "$runtime_dir/lobster-resume-token" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";

const [runPath, tokenPath] = process.argv.slice(2);
const { run: invocation } = JSON.parse(await readFile(runPath, "utf8"));
const details = invocation.output?.details;
const token = details?.requiresApproval?.resumeToken;
if (
  invocation.ok !== true ||
  invocation.toolName !== "lobster" ||
  invocation.source !== "plugin" ||
  details?.ok !== true ||
  details?.status !== "needs_approval" ||
  typeof token !== "string" ||
  token.length < 16
) {
  throw new Error("container Lobster workflow did not pause for approval");
}
await writeFile(tokenPath, `${token}\n`, { encoding: "utf8", mode: 0o600 });
NODE

# Prove that the approval checkpoint survives a complete Gateway process and
# container restart on the same persistent state volume.
docker rm -f "$gateway_container" >/dev/null
start_gateway
wait_for_gateway
lobster_resume_token="$(<"$runtime_dir/lobster-resume-token")"
docker exec -i \
  -e "GUARDIAN_PROOF_RESUME_TOKEN=$lobster_resume_token" \
  "$gateway_container" node --input-type=module - \
  >"$runtime_dir/lobster-resume.json" <<'NODE'
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const client = new GatewayClient({
  url: "ws://127.0.0.1:18789",
  token: process.env.OPENCLAW_GATEWAY_TOKEN,
  clientName: "gateway-client",
  clientDisplayName: "dataops-guardian-container-resume-proof",
  clientVersion: "2026.6.34",
  platform: process.platform,
  mode: "backend",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 20_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});

try {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Gateway resume client timeout")), 15_000),
    ),
  ]);
  const invocation = await client.request("tools.invoke", {
    name: "lobster",
    args: {
      action: "resume",
      token: process.env.GUARDIAN_PROOF_RESUME_TOKEN,
      approve: true,
      cwd: ".",
      timeoutMs: 15_000,
    },
  });
  process.stdout.write(`${JSON.stringify(invocation)}\n`);
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
NODE
node --input-type=module - "$runtime_dir/lobster-resume.json" <<'NODE'
import { readFile } from "node:fs/promises";

const invocation = JSON.parse(await readFile(process.argv[2], "utf8"));
const details = invocation.output?.details;
const recovery = details?.output?.at(-1);
if (
  invocation.ok !== true ||
  invocation.toolName !== "lobster" ||
  invocation.source !== "plugin" ||
  details?.ok !== true ||
  details?.status !== "ok" ||
  details?.requiresApproval !== null ||
  recovery?.step !== "recovery" ||
  recovery?.alertId !== "container-restart-proof" ||
  recovery?.metric !== "kubernetes_deployment_revision" ||
  recovery?.healthy !== true
) {
  throw new Error("container Lobster workflow did not resume after Gateway restart");
}
NODE
lobster_approval_restart_passed=true

docker run -d \
  --name "$bridge_container" \
  --network "container:$gateway_container" \
  -e "ALERTMANAGER_BRIDGE_HOST=127.0.0.1" \
  -e "ALERTMANAGER_BRIDGE_PORT=9187" \
  -e "ALERTMANAGER_BRIDGE_TOKEN=$alert_token" \
  -e "ALERTMANAGER_BRIDGE_STATE_DIR=/var/lib/dataops-guardian" \
  -e "OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789" \
  -e "OPENCLAW_GATEWAY_TOKEN=$gateway_token" \
  --mount "type=volume,source=$bridge_volume,destination=/var/lib/dataops-guardian" \
  "$image_ref" bridge >/dev/null

bridge_ready=false
for _ in $(seq 1 80); do
  if docker logs "$bridge_container" 2>&1 |
    grep -q '"msg":"alertmanager http bridge listening"'; then
    bridge_ready=true
    break
  fi
  if ! docker inspect -f '{{.State.Running}}' "$bridge_container" 2>/dev/null |
    grep -qx true; then
    break
  fi
  sleep 0.5
done
if [[ "$bridge_ready" != true ]]; then
  docker logs "$bridge_container" >"$runtime_dir/bridge.log" 2>&1 || true
  tail -n 120 "$runtime_dir/bridge.log" >&2 || true
  echo "container Bridge did not become ready" >&2
  exit 1
fi

unauthorized_status="$(docker exec "$bridge_container" node -e \
  "fetch('http://127.0.0.1:9187/v1/alertmanager/webhook',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(r=>process.stdout.write(String(r.status)))")"
if [[ "$unauthorized_status" != 401 ]]; then
  echo "container Bridge unauthenticated webhook was not rejected" >&2
  exit 1
fi

docker rm -f "$bridge_container" >/dev/null
docker volume create "$corrupt_volume" >/dev/null
corrupt_seed_container="guardian-image-corrupt-seed-${source_commit:0:8}-${run_token}"
if docker container inspect "$corrupt_seed_container" >/dev/null 2>&1; then
  echo "container image proof target already exists: $corrupt_seed_container" >&2
  exit 1
fi
negative_containers+=("$corrupt_seed_container")
set +e
timeout --foreground --signal=TERM --kill-after=5s 15s \
  docker run --rm --name "$corrupt_seed_container" \
  --network none --entrypoint node \
  --mount "type=volume,source=$corrupt_volume,destination=/var/lib/dataops-guardian" \
  "$image_ref" -e \
  "require('node:fs').writeFileSync('/var/lib/dataops-guardian/bridge-state.json','{')" \
  >"$runtime_dir/corrupt-seed.out" 2>"$runtime_dir/corrupt-seed.err"
corrupt_seed_status=$?
set -e
if ((corrupt_seed_status != 0)); then
  echo "could not create the corrupt-state fixture (exit $corrupt_seed_status)" >&2
  exit 1
fi

corrupt_container="guardian-image-corrupt-${source_commit:0:8}-${run_token}"
if docker container inspect "$corrupt_container" >/dev/null 2>&1; then
  echo "container image proof target already exists: $corrupt_container" >&2
  exit 1
fi
negative_containers+=("$corrupt_container")
set +e
timeout --foreground --signal=TERM --kill-after=5s 15s \
  docker run --rm --name "$corrupt_container" \
  --network "container:$gateway_container" \
  -e "ALERTMANAGER_BRIDGE_TOKEN=$alert_token" \
  -e "ALERTMANAGER_BRIDGE_STATE_DIR=/var/lib/dataops-guardian" \
  -e "OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789" \
  -e "OPENCLAW_GATEWAY_TOKEN=$gateway_token" \
  --mount "type=volume,source=$corrupt_volume,destination=/var/lib/dataops-guardian" \
  "$image_ref" bridge \
  >"$runtime_dir/corrupt-state.out" 2>"$runtime_dir/corrupt-state.err"
corrupt_status=$?
set -e
if ((corrupt_status != 1)) ||
  ! grep -q "JSON.parse" "$runtime_dir/corrupt-state.err" ||
  grep -q "ECONNREFUSED" "$runtime_dir/corrupt-state.err" ||
  grep -q "alertmanager http bridge listening" \
    "$runtime_dir/corrupt-state.out" "$runtime_dir/corrupt-state.err"; then
  echo "corrupt Bridge state did not fail before Gateway connection" >&2
  exit 1
fi
corrupt_bridge_state_passed=true

printf '[container] final-layer sentinel scan\n' >&2
docker save --output "$runtime_dir/image.tar" "$image_ref"
if grep -aFq "$host_sentinel" "$runtime_dir/image.tar"; then
  echo "ignored host artifact leaked into the final image" >&2
  exit 1
fi
host_dist_excluded_passed=true

printf '[container] owned-resource cleanup\n' >&2
remove_owned_host_sentinel
cleanup_docker_resources
for container in "$gateway_container" "$bridge_container" \
  "${negative_containers[@]}"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo "container image proof failed to remove container: $container" >&2
    exit 1
  fi
done
if docker network inspect "$network_name" >/dev/null 2>&1; then
  echo "container image proof failed to remove network: $network_name" >&2
  exit 1
fi
for volume in "$gateway_volume" "$bridge_volume" "$corrupt_volume"; do
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    echo "container image proof failed to remove volume: $volume" >&2
    exit 1
  fi
done
if docker image inspect "$image_ref" >/dev/null 2>&1; then
  echo "container image proof failed to remove image tag: $image_ref" >&2
  exit 1
fi
if [[ -e "$host_sentinel_path" ]]; then
  echo "container image proof failed to remove its host sentinel" >&2
  exit 1
fi

node -e '
  const negativeContracts = {
    unknownRole: process.argv[3] === "true",
    missingArtifact: process.argv[4] === "true",
    missingGatewayEnvironment: process.argv[5] === "true",
    missingBridgeEnvironment: process.argv[6] === "true",
    corruptBridgeState: process.argv[7] === "true",
    hostDistExcluded: process.argv[8] === "true",
    arbitraryLobsterBlocked: process.argv[9] === "true",
    unwritableBridgeState: process.argv[10] === "true",
    reusedBridgeCredentials: process.argv[11] === "true",
  };
  const lobsterApprovalRestart = process.argv[12] === "true";
  if (
    Object.values(negativeContracts).some((value) => value !== true) ||
    !lobsterApprovalRestart
  ) {
    throw new Error("container proof did not complete every runtime contract");
  }
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    proof: "dataops-guardian-container-image",
    sourceRevision: process.argv[1],
    guardianVersion: process.argv[2],
    nodeVersion: "24.16.0",
    openclawVersion: "2026.6.34",
    lobsterVersion: "2026.6.34",
    roles: { gateway: true, bridge: true },
    runtimeRegistration: {
      tools: 5,
      hooks: 5,
      lobsterApprovalRestart,
    },
    negativeContracts,
    cleanup: true,
    imagePublished: false,
  })}\n`);
' "$source_commit" "$guardian_version" \
  "$unknown_role_passed" \
  "$missing_artifact_passed" \
  "$missing_gateway_environment_passed" \
  "$missing_bridge_environment_passed" \
  "$corrupt_bridge_state_passed" \
  "$host_dist_excluded_passed" \
  "$arbitrary_lobster_blocked_passed" \
  "$unwritable_bridge_state_passed" \
  "$reused_bridge_credentials_passed" \
  "$lobster_approval_restart_passed"
