#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-smoke}"
if [[ "$MODE" != "smoke" && "$MODE" != "formal" ]]; then
  echo "usage: bash scripts/run-openrouter-ab.sh [smoke|formal]" >&2
  exit 2
fi
PROVIDER_MODE="${GUARDIAN_AB_PROVIDER_MODE:-openrouter}"
if [[ "$PROVIDER_MODE" != "openrouter" && "$PROVIDER_MODE" != "scripted" ]]; then
  echo "GUARDIAN_AB_PROVIDER_MODE must be openrouter or scripted" >&2
  exit 2
fi
if [[ "$PROVIDER_MODE" == "openrouter" && -z "${OPENROUTER_API_KEY:-}" ]]; then
  echo "OPENROUTER_API_KEY is not set. Set it in your shell; never paste it into chat or commit it." >&2
  echo "Preview the no-cost schedule with: npm run eval:openrouter:plan" >&2
  exit 2
fi

ROOT_DIR="$PWD"
RUN_ID="${GUARDIAN_AB_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$MODE}"
STATE_ROOT="${GUARDIAN_AB_STATE_ROOT:-$ROOT_DIR/.openclaw-openrouter-ab/$RUN_ID}"
RESULT_ROOT="${GUARDIAN_AB_RESULT_ROOT:-$ROOT_DIR/evals/openrouter-ab/results/$RUN_ID}"
AB_MODEL="${GUARDIAN_AB_MODEL:-openrouter/openai/gpt-4.1-mini}"
if [[ "$PROVIDER_MODE" == "scripted" ]]; then
  AB_MODEL="guardian-scripted/scripted-finalizer"
fi
MAX_COST_USD="${GUARDIAN_AB_MAX_COST_USD:-$(if [[ "$MODE" == "smoke" ]]; then echo 0.25; else echo 1.00; fi)}"
MAX_TRIALS="${GUARDIAN_AB_MAX_TRIALS:-0}"
OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19186}"
GUARDIAN_MOCK_PROMETHEUS_PORT="${GUARDIAN_MOCK_PROMETHEUS_PORT:-19093}"
GUARDIAN_MOCK_MODEL_PORT="${GUARDIAN_MOCK_MODEL_PORT:-19094}"
OPENCLAW_GATEWAY_TOKEN="${OPENCLAW_GATEWAY_TOKEN:-guardian-openrouter-ab-local-only}"

export OPENCLAW_GATEWAY_PORT OPENCLAW_GATEWAY_TOKEN

mkdir -p "$STATE_ROOT" "$RESULT_ROOT/trials"
node scripts/openrouter-ab-plan.mjs "$MODE" >"$RESULT_ROOT/plan.json"

GATEWAY_PID=""
PROMETHEUS_PID=""
MODEL_PID=""

stop_processes() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  GATEWAY_PID=""
  if [[ -n "$PROMETHEUS_PID" ]] && kill -0 "$PROMETHEUS_PID" 2>/dev/null; then
    kill "$PROMETHEUS_PID"
    wait "$PROMETHEUS_PID" || true
  fi
  PROMETHEUS_PID=""
  if [[ -n "$MODEL_PID" ]] && kill -0 "$MODEL_PID" 2>/dev/null; then
    kill "$MODEL_PID"
    wait "$MODEL_PID" || true
  fi
  MODEL_PID=""
}
trap stop_processes EXIT

wait_for_port() {
  local port="$1"
  local pid="$2"
  local label="$3"
  for _ in $(seq 1 120); do
    if (exec 3<>/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  echo "$label did not become ready on port $port" >&2
  return 1
}

CUMULATIVE_COST="0"
COMPLETED_TRIALS=0
while IFS=$'\t' read -r trial_id scenario replicate arm delay_ms; do
  stop_processes
  trial_state="$STATE_ROOT/$trial_id"
  trial_result="$RESULT_ROOT/trials/$trial_id"
  mkdir -p "$trial_state" "$trial_result"

  export OPENCLAW_STATE_DIR="$trial_state"
  export OPENCLAW_WORKSPACE_DIR="$trial_state/workspace"
  export GUARDIAN_AB_TRIAL_ID="$trial_id"
  export GUARDIAN_AB_SCENARIO="$scenario"
  export GUARDIAN_AB_REPLICATE="$replicate"
  export GUARDIAN_AB_SESSION_KEY="agent:main:dataops-guardian-ab-$trial_id-$(date +%s%N)"
  export GUARDIAN_MOCK_PROMETHEUS_DELAY_MS="$delay_ms"

  gate_mode="disabled"
  if [[ "$arm" == "gated" ]]; then
    gate_mode="all_agent_runs"
  fi

  ./node_modules/.bin/openclaw plugins install --link "$ROOT_DIR" >/dev/null
  ./node_modules/.bin/openclaw config set gateway.mode local >/dev/null
  ./node_modules/.bin/openclaw config set gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
  ./node_modules/.bin/openclaw config set gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
  ./node_modules/.bin/openclaw config set agents.defaults.skipBootstrap true >/dev/null
  ./node_modules/.bin/openclaw config set agents.defaults.workspace "$OPENCLAW_WORKSPACE_DIR" >/dev/null
  ./node_modules/.bin/openclaw config set tools.allow \
    '["guardian_query_prometheus","guardian_inspect_metric_snapshot"]' \
    --strict-json >/dev/null
  ./node_modules/.bin/openclaw config set \
    plugins.entries.dataops-guardian.hooks.allowConversationAccess true >/dev/null
  ./node_modules/.bin/openclaw config set \
    plugins.entries.dataops-guardian.config.prometheusBaseUrl \
    "http://127.0.0.1:$GUARDIAN_MOCK_PROMETHEUS_PORT" >/dev/null
  ./node_modules/.bin/openclaw config set \
    plugins.entries.dataops-guardian.config.prometheusTimeoutMs 5000 >/dev/null
  ./node_modules/.bin/openclaw config set \
    plugins.entries.dataops-guardian.config.requireToolsGateMode \
    "$gate_mode" >/dev/null
  if [[ "$PROVIDER_MODE" == "scripted" ]]; then
    ./node_modules/.bin/openclaw config set models.providers.guardian-scripted \
      "{\"baseUrl\":\"http://127.0.0.1:$GUARDIAN_MOCK_MODEL_PORT/v1\",\"apiKey\":\"local-fixture-key\",\"api\":\"openai-completions\",\"models\":[{\"id\":\"scripted-finalizer\",\"name\":\"Guardian Scripted Finalizer\",\"reasoning\":false,\"input\":[\"text\"],\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0},\"contextWindow\":128000,\"contextTokens\":96000,\"maxTokens\":4096}]}" \
      --strict-json --merge >/dev/null
  fi
  ./node_modules/.bin/openclaw config set \
    agents.defaults.model.primary "$AB_MODEL" >/dev/null
  ./node_modules/.bin/openclaw config set agents.defaults.models \
    "{\"$AB_MODEL\":{\"params\":{\"temperature\":0.2,\"maxTokens\":512}}}" \
    --strict-json --merge >/dev/null

  : >"$trial_result/prometheus-requests.jsonl"
  node scripts/mock-prometheus-server.mjs \
    "$GUARDIAN_MOCK_PROMETHEUS_PORT" \
    "$trial_result/prometheus-requests.jsonl" \
    >"$trial_result/prometheus.log" 2>&1 &
  PROMETHEUS_PID=$!
  wait_for_port "$GUARDIAN_MOCK_PROMETHEUS_PORT" "$PROMETHEUS_PID" "mock Prometheus"

  if [[ "$PROVIDER_MODE" == "scripted" ]]; then
    : >"$trial_result/model-requests.jsonl"
    node scripts/mock-openai-finalizer.mjs \
      "$GUARDIAN_MOCK_MODEL_PORT" \
      "$trial_result/model-requests.jsonl" \
      >"$trial_result/model.log" 2>&1 &
    MODEL_PID=$!
    wait_for_port "$GUARDIAN_MOCK_MODEL_PORT" "$MODEL_PID" "scripted model"
  fi

  ./node_modules/.bin/openclaw gateway run \
    --port "$OPENCLAW_GATEWAY_PORT" \
    --bind loopback \
    --auth token \
    --allow-unconfigured >"$trial_result/gateway.log" 2>&1 &
  GATEWAY_PID=$!
  wait_for_port "$OPENCLAW_GATEWAY_PORT" "$GATEWAY_PID" "Gateway"

  node scripts/openrouter-ab-agent-rpc.mjs >"$trial_result/rpc.json"
  stop_processes

  node scripts/extract-openrouter-ab-trial.mjs \
    "$trial_state" \
    "$trial_result/rpc.json" \
    "$trial_result/gateway.log" \
    "$arm" \
    "$trial_result/summary.json" \
    "$trial_result/raw.json" \
    "$trial_result/hook-audit.jsonl"

  trial_cost=$(node --input-type=module -e \
    'import {readFile} from "node:fs/promises"; const value=JSON.parse(await readFile(process.argv[1],"utf8")); process.stdout.write(String(value.usage.costUsd));' \
    "$trial_result/summary.json")
  CUMULATIVE_COST=$(node -e \
    'process.stdout.write(String(Number(process.argv[1])+Number(process.argv[2])))' \
    "$CUMULATIVE_COST" "$trial_cost")
  echo "trial=$trial_id arm=$arm scenario=$scenario cost_usd=$trial_cost cumulative_usd=$CUMULATIVE_COST"
  COMPLETED_TRIALS=$((COMPLETED_TRIALS + 1))

  if [[ "$MAX_TRIALS" -gt 0 && "$COMPLETED_TRIALS" -ge "$MAX_TRIALS" ]]; then
    echo "Stopping after requested trial cap: $MAX_TRIALS"
    break
  fi

  over_budget=$(node -e \
    'process.stdout.write(Number(process.argv[1]) >= Number(process.argv[2]) ? "yes" : "no")' \
    "$CUMULATIVE_COST" "$MAX_COST_USD")
  if [[ "$over_budget" == "yes" ]]; then
    echo "Stopping: recorded cost reached the hard run budget of USD $MAX_COST_USD" >&2
    break
  fi
done < <(node scripts/openrouter-ab-plan.mjs "$MODE" tsv)

node scripts/summarize-openrouter-ab.mjs "$RESULT_ROOT"
echo "OpenRouter A/B artifacts: $RESULT_ROOT"
