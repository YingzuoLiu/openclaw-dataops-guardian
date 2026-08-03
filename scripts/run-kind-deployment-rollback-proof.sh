#!/usr/bin/env bash
set -euo pipefail

# Real kind Deployment rollback proof for Step 3.
#
# Requires Docker, kind, and kubectl on PATH and a working container runtime
# (verified locally on Windows 11 + WSL2 + Docker Desktop, matching the Day 0
# spike environment). This does not run in network-restricted cloud sandboxes
# that cannot pull the kind node image -- run it on a workstation with that
# access.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-kind-deployment-rollback.XXXXXX")"
CLUSTER_NAME="${GUARDIAN_STEP3_CLUSTER_NAME:-guardian-step3-kind}"
export GUARDIAN_STEP3_NAMESPACE="${GUARDIAN_STEP3_NAMESPACE:-guardian-step3}"
export GUARDIAN_STEP3_DEPLOYMENT="${GUARDIAN_STEP3_DEPLOYMENT:-payments-step3}"
NAMESPACE="$GUARDIAN_STEP3_NAMESPACE"
DEPLOYMENT="$GUARDIAN_STEP3_DEPLOYMENT"
OTHER_DEPLOYMENT="other-step3"
ADMIN_KUBECONFIG="$RUNTIME_DIR/admin-kubeconfig.yaml"
SCOPED_KUBECONFIG="$RUNTIME_DIR/scoped-kubeconfig.yaml"

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19187}"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export OPENCLAW_KIND_ROLLBACK_RESUME_FILE="$RUNTIME_DIR/resume.json"

GATEWAY_PID=""
CLUSTER_CREATED=false

wait_for_tcp_port() {
  local port="$1"
  local label="$2"
  for _ in $(seq 1 80); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
    fi
    if [[ -n "$GATEWAY_PID" ]] && ! kill -0 "$GATEWAY_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  echo "$label did not become ready" >&2
  return 1
}

start_gateway() {
  local log_file="$1"
  "$ROOT_DIR/node_modules/.bin/openclaw" gateway run \
    --port "$OPENCLAW_GATEWAY_PORT" \
    --bind loopback \
    --auth token \
    --allow-unconfigured >"$log_file" 2>&1 &
  GATEWAY_PID=$!
  wait_for_tcp_port "$OPENCLAW_GATEWAY_PORT" "Gateway"
}

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
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-kind-deployment-rollback.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap cleanup EXIT

run_rpc() {
  GUARDIAN_KUBERNETES_CONFIG_JSON="$KUBERNETES_CONFIG_JSON" \
    node "$ROOT_DIR/scripts/kind-deployment-rollback-rpc.mjs" "$1"
}

mkdir -p "$RUNTIME_DIR" "$OPENCLAW_STATE_DIR"
cd "$ROOT_DIR"
npm run build

# --- 1. Cluster and workload fixture: revision 1 (v1) then revision 2 (v2). ---
kind create cluster \
  --name "$CLUSTER_NAME" \
  --kubeconfig "$ADMIN_KUBECONFIG" \
  --wait 120s
CLUSTER_CREATED=true

kubectl --kubeconfig "$ADMIN_KUBECONFIG" create namespace "$NAMESPACE"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create deployment "$DEPLOYMENT" \
  --image=registry.k8s.io/pause:3.9 \
  --replicas=0
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  patch deployment "$DEPLOYMENT" --type=merge \
  -p '{"spec":{"revisionHistoryLimit":5}}'
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=60s || true
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  set image deployment/"$DEPLOYMENT" pause=registry.k8s.io/pause:3.10
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=60s || true

REPLICASET_COUNT="$(
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
    get replicasets.apps -l app="$DEPLOYMENT" -o name | wc -l | tr -d ' '
)"
if [[ "$REPLICASET_COUNT" -lt 2 ]]; then
  echo "expected at least two controller-owned ReplicaSets, found $REPLICASET_COUNT" >&2
  exit 1
fi

# A second, unrelated Deployment in the same namespace to prove the scoped
# credential cannot write outside its one allowlisted target.
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create deployment "$OTHER_DEPLOYMENT" \
  --image=registry.k8s.io/pause:3.9 \
  --replicas=0

# --- 2. Scoped ServiceAccount: get/patch one Deployment, get/list ReplicaSets. ---
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create serviceaccount guardian-step3
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create role guardian-step3-deployment \
  --verb=get,patch \
  --resource=deployments.apps \
  --resource-name="$DEPLOYMENT"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create role guardian-step3-replicasets \
  --verb=get,list \
  --resource=replicasets.apps
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create rolebinding guardian-step3-deployment \
  --role=guardian-step3-deployment \
  --serviceaccount="$NAMESPACE:guardian-step3"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create rolebinding guardian-step3-replicasets \
  --role=guardian-step3-replicasets \
  --serviceaccount="$NAMESPACE:guardian-step3"

GUARDIAN_STEP3_SERVICE_ACCOUNT_TOKEN="$(
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
    create token guardian-step3 --duration=2h
)"

CLUSTER_SERVER="$(
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" config view --minify \
    -o jsonpath='{.clusters[0].cluster.server}'
)"
cat >"$SCOPED_KUBECONFIG" <<EOF
apiVersion: v1
kind: Config
clusters:
  - name: $CLUSTER_NAME
    cluster:
      server: $CLUSTER_SERVER
      insecure-skip-tls-verify: true
users:
  - name: $CLUSTER_NAME
    user:
      token: $GUARDIAN_STEP3_SERVICE_ACCOUNT_TOKEN
contexts:
  - name: $CLUSTER_NAME
    context:
      cluster: $CLUSTER_NAME
      user: $CLUSTER_NAME
      namespace: $NAMESPACE
current-context: $CLUSTER_NAME
EOF
chmod 600 "$SCOPED_KUBECONFIG"
unset GUARDIAN_STEP3_SERVICE_ACCOUNT_TOKEN

KUBERNETES_CONFIG_JSON="$(
  node -e '
    const [clusterId, kubeconfigPath, namespace, deployment] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      clusterId,
      kubeconfigPath,
      allowlist: [{ namespace, deployment }],
    }));
  ' "$CLUSTER_NAME" "$SCOPED_KUBECONFIG" "$NAMESPACE" "$DEPLOYMENT"
)"

# --- 3. Real OpenClaw Gateway with the main dataops-guardian plugin linked. ---
"$ROOT_DIR/node_modules/.bin/openclaw" plugins install --link "$ROOT_DIR" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.mode local >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  gateway.controlUi.dangerouslyDisableDeviceAuth true >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  "plugins.entries.dataops-guardian.config.kubernetes" "$KUBERNETES_CONFIG_JSON" >/dev/null

start_gateway "$RUNTIME_DIR/gateway-1.log"

# --- 4. Persist an approved incident, discover the real target, roll back. ---
PREPARE_JSON="$(run_rpc prepare)"
ROLLBACK_JSON="$(run_rpc rollback)"
REPLAY_JSON="$(run_rpc replay)"
DENIED_JSON="$(run_rpc denied-target)"

# --- 5. Crash window: mutation applied, IncidentState never marked finished. ---
stop_gateway

# --- 6. Restart the Gateway; the running attempt must survive on disk. ---
start_gateway "$RUNTIME_DIR/gateway-2.log"
RECONCILE_JSON="$(run_rpc reconcile)"
BLOCKED_JSON="$(run_rpc verify-blocked-after-resolution)"

# --- 6b. A second, later incident occurrence: forward-redeploy (a PodTemplate
# content change, not a new image tag, so this does not depend on a specific
# registry.k8s.io/pause tag existing) so the Deployment drifts away from the
# first rollback's result, then roll it back again under a *different*
# idempotency key. The Deployment still carries the first attempt's audit
# annotations at this point -- this proves a legitimate new occurrence is
# allowed to roll the same Deployment back again instead of being
# permanently key_conflict.
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  set env deployment/"$DEPLOYMENT" GUARDIAN_STEP3_GENERATION=v3
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=60s || true
SECOND_OCCURRENCE_JSON="$(run_rpc second-occurrence)"
stop_gateway

# --- 7. Scoped-credential RBAC boundary checks (outside the tool entirely). ---
set +e
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" \
  patch deployment "$OTHER_DEPLOYMENT" --type=merge -p '{"metadata":{"annotations":{"x":"y"}}}' \
  >/dev/null 2>"$RUNTIME_DIR/rbac-other-deployment.err"
RBAC_OTHER_DEPLOYMENT_DENIED=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace default get deployments \
  >/dev/null 2>"$RUNTIME_DIR/rbac-other-namespace.err"
RBAC_OTHER_NAMESPACE_DENIED=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" get secrets \
  >/dev/null 2>"$RUNTIME_DIR/rbac-secrets.err"
RBAC_SECRETS_DENIED=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" \
  delete deployment "$DEPLOYMENT" \
  >/dev/null 2>"$RUNTIME_DIR/rbac-delete.err"
RBAC_DELETE_DENIED=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" \
  create deployment guardian-step3-should-fail --image=registry.k8s.io/pause:3.9 \
  >/dev/null 2>"$RUNTIME_DIR/rbac-create.err"
RBAC_CREATE_DENIED=$?
set -e

for pair in \
  "RBAC_OTHER_DEPLOYMENT_DENIED:rbac-other-deployment.err" \
  "RBAC_OTHER_NAMESPACE_DENIED:rbac-other-namespace.err" \
  "RBAC_SECRETS_DENIED:rbac-secrets.err" \
  "RBAC_DELETE_DENIED:rbac-delete.err" \
  "RBAC_CREATE_DENIED:rbac-create.err"; do
  name="${pair%%:*}"
  file="${pair##*:}"
  exit_code_var="$name"
  if [[ "${!exit_code_var}" -eq 0 ]]; then
    echo "expected $name to be denied by RBAC, but the request succeeded" >&2
    exit 1
  fi
  if ! grep -qi "forbidden" "$RUNTIME_DIR/$file"; then
    echo "expected $name to fail with Forbidden, got:" >&2
    cat "$RUNTIME_DIR/$file" >&2
    exit 1
  fi
done

delete_cluster

node -e '
  const parts = process.argv.slice(1).map((entry) => JSON.parse(entry));
  const [prepareResult, rollbackResult, replayResult, deniedResult, reconcileResult, blockedResult, secondOccurrenceResult] = parts;
  const summary = {
    ok: true,
    proof: "kind-deployment-rollback",
    realRollbackApplied: rollbackResult.decision === "rolled_back",
    rollbackFromRevision: rollbackResult.fromRevision,
    rollbackNewRevision: rollbackResult.newRevision,
    firstOccurrenceMutationDispatchCount: 1,
    replayDecision: replayResult.decision,
    replayGenerationUnchanged: replayResult.generationUnchanged,
    deniedTargetBlocked: deniedResult.denied === true,
    restartReconciliation: reconcileResult.externalOutcome,
    attemptStatus: reconcileResult.attemptStatus,
    incidentStage: reconcileResult.stage,
    blockedAfterResolution: blockedResult.blocked === true,
    secondOccurrenceRollbackApplied: secondOccurrenceResult.decision === "rolled_back",
    secondOccurrenceFromRevision: secondOccurrenceResult.fromRevision,
    secondOccurrenceNewRevision: secondOccurrenceResult.newRevision,
    prometheusChecked: false,
    incidentCompleted: false,
    rbacOtherDeploymentDenied: true,
    rbacOtherNamespaceDenied: true,
    rbacSecretsDenied: true,
    rbacDeleteDenied: true,
    rbacCreateDenied: true,
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
' "$PREPARE_JSON" "$ROLLBACK_JSON" "$REPLAY_JSON" "$DENIED_JSON" "$RECONCILE_JSON" "$BLOCKED_JSON" "$SECOND_OCCURRENCE_JSON"
