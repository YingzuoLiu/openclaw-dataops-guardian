#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$PWD/.openclaw-live-hook-proof}"
export OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-guardian-live-hook-proof-local-only}"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19184}"
export GUARDIAN_MOCK_MODEL_PORT="${GUARDIAN_MOCK_MODEL_PORT:-19091}"
export OPENCLAW_LIVE_HOOK_SESSION_KEY="${OPENCLAW_LIVE_HOOK_SESSION_KEY:-agent:main:dataops-guardian-live-hook-proof-$(date +%s)}"
export OPENCLAW_WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$OPENCLAW_STATE_DIR/workspace}"

GATEWAY_LOG="$OPENCLAW_STATE_DIR/gateway-live-hook-proof.log"
MODEL_LOG="$OPENCLAW_STATE_DIR/mock-model.log"
MODEL_REQUESTS="$OPENCLAW_STATE_DIR/mock-model-requests.jsonl"
RPC_RESULT="$OPENCLAW_STATE_DIR/agent-run.json"
AUDIT_LOG="$OPENCLAW_STATE_DIR/hook-audit.jsonl"
PROOF_RESULT="$OPENCLAW_STATE_DIR/live-hook-proof.json"

GATEWAY_PID=""
MODEL_PID=""

cleanup() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  if [[ -n "$MODEL_PID" ]] && kill -0 "$MODEL_PID" 2>/dev/null; then
    kill "$MODEL_PID"
    wait "$MODEL_PID" || true
  fi
  ./node_modules/.bin/openclaw config unset \
    gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null || true
}
trap cleanup EXIT

mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_WORKSPACE_DIR"
: >"$MODEL_REQUESTS"
: >"$GATEWAY_LOG"

npm run build
if [[ -n "${GUARDIAN_PROOF_PLUGIN_DIR:-}" ]]; then
  PLUGIN_LOAD_PATHS="$(
    node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' \
      "$GUARDIAN_PROOF_PLUGIN_DIR"
  )"
  ./node_modules/.bin/openclaw config set \
    plugins.load.paths "$PLUGIN_LOAD_PATHS" >/dev/null
  ./node_modules/.bin/openclaw config set \
    plugins.entries.dataops-guardian.enabled true >/dev/null
else
  ./node_modules/.bin/openclaw plugins install --link "$PWD" >/dev/null
fi
./node_modules/.bin/openclaw config set gateway.mode local >/dev/null
./node_modules/.bin/openclaw config set gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
./node_modules/.bin/openclaw config set \
  gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
./node_modules/.bin/openclaw config set \
  plugins.entries.dataops-guardian.hooks.allowConversationAccess true >/dev/null
./node_modules/.bin/openclaw config set \
  plugins.entries.dataops-guardian.config.enforceRequireToolsOnAgentRuns true >/dev/null
./node_modules/.bin/openclaw config set models.providers.guardian-scripted \
  "{\"baseUrl\":\"http://127.0.0.1:$GUARDIAN_MOCK_MODEL_PORT/v1\",\"apiKey\":\"local-proof-key\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"scripted-finalizer\",\"name\":\"Guardian Scripted Finalizer\",\"reasoning\":false,\"input\":[\"text\"],\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0},\"contextWindow\":128000,\"contextTokens\":96000,\"maxTokens\":4096}]}" \
  --strict-json --merge >/dev/null
./node_modules/.bin/openclaw config set \
  agents.defaults.model.primary guardian-scripted/scripted-finalizer >/dev/null

node scripts/mock-openai-finalizer.mjs \
  "$GUARDIAN_MOCK_MODEL_PORT" "$MODEL_REQUESTS" >"$MODEL_LOG" 2>&1 &
MODEL_PID=$!

MODEL_READY=false
for _ in $(seq 1 40); do
  if (exec 4<>/dev/tcp/127.0.0.1/"$GUARDIAN_MOCK_MODEL_PORT") 2>/dev/null; then
    exec 4>&-
    exec 4<&-
    MODEL_READY=true
    break
  fi
  if ! kill -0 "$MODEL_PID" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$MODEL_READY" != true ]]; then
  echo "Mock model did not become ready" >&2
  exit 1
fi

./node_modules/.bin/openclaw gateway run \
  --port "$OPENCLAW_GATEWAY_PORT" \
  --bind loopback \
  --auth token \
  --allow-unconfigured >"$GATEWAY_LOG" 2>&1 &
GATEWAY_PID=$!

GATEWAY_READY=false
for _ in $(seq 1 80); do
  if (exec 3<>/dev/tcp/127.0.0.1/"$OPENCLAW_GATEWAY_PORT") 2>/dev/null; then
    exec 3>&-
    exec 3<&-
    GATEWAY_READY=true
    break
  fi
  if ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
    break
  fi
  sleep 0.25
done
if [[ "$GATEWAY_READY" != true ]]; then
  echo "Gateway did not become ready" >&2
  exit 1
fi

node scripts/live-hook-agent-rpc.mjs >"$RPC_RESULT"

node --input-type=module - \
  "$GATEWAY_LOG" "$MODEL_REQUESTS" "$RPC_RESULT" "$AUDIT_LOG" "$PROOF_RESULT" <<'NODE'
import { readFile, writeFile } from "node:fs/promises";
import { extractGuardianAuditEvents } from "./scripts/gateway-audit-log.mjs";

const [gatewayPath, requestsPath, rpcPath, auditPath, proofPath] =
  process.argv.slice(2);
const gatewayLog = await readFile(gatewayPath, "utf8");
const requestLines = (await readFile(requestsPath, "utf8"))
  .split("\n")
  .filter(Boolean);
const requests = requestLines.map((line) => JSON.parse(line));
const rpc = JSON.parse(await readFile(rpcPath, "utf8"));
const auditEvents = extractGuardianAuditEvents(gatewayLog);

const hasActivation = auditEvents
  .some(
    (event) =>
      event.hook === "before_agent_run" && event.decision === "activate",
  );
const hasRevision = auditEvents
  .some(
    (event) =>
      event.hook === "before_agent_finalize" && event.decision === "revise",
  );
const activationEvents = auditEvents.filter(
  (event) =>
    event.hook === "before_agent_run" && event.decision === "activate",
);
const revisionEvents = auditEvents.filter(
  (event) =>
    event.hook === "before_agent_finalize" && event.decision === "revise",
);
const observedRunIds = new Set(
  [...activationEvents, ...revisionEvents]
    .map((event) => event.runId)
    .filter(Boolean),
);

if (!rpc.ok || !rpc.gatewayAgentRun) {
  throw new Error(`Gateway agent proof failed: ${JSON.stringify(rpc)}`);
}
if (!hasActivation || !hasRevision) {
  throw new Error(
    `live hook invocation was not observed: ${JSON.stringify({ hasActivation, hasRevision })}`,
  );
}
if (requests.length !== 2) {
  throw new Error(
    `expected one initial model call plus one bounded revision, observed ${requests.length}`,
  );
}
if (
  activationEvents.length !== requests.length ||
  revisionEvents.length !== requests.length
) {
  throw new Error(
    `expected each model attempt to cross both hooks: ${JSON.stringify({ activations: activationEvents.length, revisions: revisionEvents.length, modelCalls: requests.length })}`,
  );
}
if (observedRunIds.size !== 1 || !observedRunIds.has(rpc.runId)) {
  throw new Error(
    `expected both attempts to share the Gateway run id: ${JSON.stringify({ rpcRunId: rpc.runId, observedRunIds: [...observedRunIds] })}`,
  );
}

await writeFile(
  auditPath,
  `${auditEvents.map((event) => JSON.stringify(event)).join("\n")}\n`,
  "utf8",
);

const proof = {
  schemaVersion: 1,
  ok: true,
  gatewayAgentRun: true,
  hookActivationObserved: hasActivation,
  finalizeRevisionObserved: hasRevision,
  hookAttemptsObserved: activationEvents.length,
  singleRunAcrossAttempts: true,
  modelCalls: requests.length,
  expectedModelCalls: 2,
  apiCostUsd: 0,
  runId: rpc.runId,
  rawEvidence: {
    gatewayLog: gatewayPath,
    hookAudit: auditPath,
    modelRequests: requestsPath,
    agentRun: rpcPath,
  },
};
await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(proof)}\n`);
NODE
