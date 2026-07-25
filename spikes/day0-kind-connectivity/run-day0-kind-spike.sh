#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SPIKE_DIR="$ROOT_DIR/spikes/day0-kind-connectivity"
ARTIFACT_DIR="$SPIKE_DIR/artifacts"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-day0-kind.XXXXXX")"
CLUSTER_NAME="${GUARDIAN_DAY0_CLUSTER_NAME:-guardian-day0}"
ADMIN_KUBECONFIG="$RUNTIME_DIR/admin-kubeconfig.yaml"
SCOPED_KUBECONFIG="$RUNTIME_DIR/scoped-kubeconfig.yaml"

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19185}"

GATEWAY_PID=""
CLUSTER_CREATED=false

stop_gateway() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  GATEWAY_PID=""
}

delete_cluster() {
  if [[ "$CLUSTER_CREATED" == true ]]; then
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null
    CLUSTER_CREATED=false
  fi
}

cleanup() {
  stop_gateway
  "$ROOT_DIR/node_modules/.bin/openclaw" config unset \
    gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null 2>&1 || true
  delete_cluster
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-day0-kind.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap cleanup EXIT

mkdir -p "$ARTIFACT_DIR" "$OPENCLAW_STATE_DIR"
node "$SPIKE_DIR/preflight.mjs" >"$ARTIFACT_DIR/preflight.json"

NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/guardian-npm-cache}" \
  npm --prefix "$SPIKE_DIR" ci --ignore-scripts
npm --prefix "$SPIKE_DIR" test

kind create cluster \
  --name "$CLUSTER_NAME" \
  --kubeconfig "$ADMIN_KUBECONFIG" \
  --wait 120s
CLUSTER_CREATED=true

kubectl --kubeconfig "$ADMIN_KUBECONFIG" create namespace guardian-day0
kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  --namespace guardian-day0 create deployment payments-day0 \
  --image=registry.k8s.io/pause:3.10 \
  --replicas=0
kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  --namespace guardian-day0 annotate deployment payments-day0 \
  guardian.openclaw.dev/day0-spike=baseline
kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  --namespace guardian-day0 create serviceaccount guardian-day0
kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  --namespace guardian-day0 create role guardian-day0 \
  --verb=get,patch \
  --resource=deployments.apps \
  --resource-name=payments-day0
kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
  --namespace guardian-day0 create rolebinding guardian-day0 \
  --role=guardian-day0 \
  --serviceaccount=guardian-day0:guardian-day0

GUARDIAN_DAY0_SERVICE_ACCOUNT_TOKEN="$(
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" \
    --namespace guardian-day0 create token guardian-day0 --duration=1h
)"
export GUARDIAN_DAY0_SERVICE_ACCOUNT_TOKEN
node "$SPIKE_DIR/write-scoped-kubeconfig.mjs" \
  "$ADMIN_KUBECONFIG" "$SCOPED_KUBECONFIG"
unset GUARDIAN_DAY0_SERVICE_ACCOUNT_TOKEN

node "$SPIKE_DIR/rbac-proof.mjs" \
  "$SCOPED_KUBECONFIG" >"$RUNTIME_DIR/rbac.json"

"$ROOT_DIR/node_modules/.bin/openclaw" plugins install \
  --link "$SPIKE_DIR" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.mode local >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  plugins.entries.guardian-day0-kind-connectivity.config.kubeconfigPath \
  "$SCOPED_KUBECONFIG" >/dev/null

"$ROOT_DIR/node_modules/.bin/openclaw" gateway run \
  --port "$OPENCLAW_GATEWAY_PORT" \
  --bind loopback \
  --auth token \
  --allow-unconfigured >"$RUNTIME_DIR/gateway.log" 2>&1 &
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

node "$SPIKE_DIR/rpc.mjs" full >"$RUNTIME_DIR/rpc.json"
stop_gateway
"$ROOT_DIR/node_modules/.bin/openclaw" config unset \
  gateway.controlUi.dangerouslyDisableDeviceAuth >/dev/null 2>&1 || true

delete_cluster
if kind get clusters | grep -Fxq "$CLUSTER_NAME"; then
  echo '{"ok":false,"clusterDeleted":false}' >"$RUNTIME_DIR/cleanup.json"
  echo "kind cluster cleanup verification failed" >&2
  exit 1
fi
echo '{"ok":true,"clusterDeleted":true,"temporaryRuntimeRemovedOnExit":true}' \
  >"$RUNTIME_DIR/cleanup.json"

node "$SPIKE_DIR/summarize-proof.mjs" \
  "$ARTIFACT_DIR/preflight.json" \
  "$RUNTIME_DIR/rbac.json" \
  "$RUNTIME_DIR/rpc.json" \
  "$RUNTIME_DIR/cleanup.json" \
  >"$ARTIFACT_DIR/day0-kind-proof.json"

process_result="$(node -e \
  'const p=require(process.argv[1]); process.stdout.write(JSON.stringify({ok:p.ok,apiServer:p.apiServer,controlledWrite:p.controlledWrite,boundaries:p.boundaries,cleanup:p.cleanup}))' \
  "$ARTIFACT_DIR/day0-kind-proof.json")"
printf '%s\n' "$process_result"
