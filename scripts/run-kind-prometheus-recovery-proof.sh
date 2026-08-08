#!/usr/bin/env bash
set -euo pipefail

# Step 4: real kind Deployment rollback plus real Prometheus recovery proof.
# Requires Docker, kind, kubectl, and network access to pull the pinned proof
# images. All cluster state, credentials, OpenClaw state, and port forwards are
# isolated under a proof-owned temporary directory and removed on exit.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-kind-prometheus-recovery.XXXXXX")"
CLUSTER_NAME="${GUARDIAN_STEP4_CLUSTER_NAME:-guardian-step4-kind}"
export GUARDIAN_STEP4_NAMESPACE="${GUARDIAN_STEP4_NAMESPACE:-guardian-step4}"
export GUARDIAN_STEP4_DEPLOYMENT="${GUARDIAN_STEP4_DEPLOYMENT:-payments-step4}"
export GUARDIAN_STEP4_PROMETHEUS_QUERY='payment_success_rate{service="payments",environment="proof"}'
NAMESPACE="$GUARDIAN_STEP4_NAMESPACE"
DEPLOYMENT="$GUARDIAN_STEP4_DEPLOYMENT"
PROMETHEUS_SERVICE="prometheus-step4"
PROMETHEUS_PORT="${GUARDIAN_STEP4_PROMETHEUS_PORT:-19091}"
ADMIN_KUBECONFIG="$RUNTIME_DIR/admin-kubeconfig.yaml"
SCOPED_KUBECONFIG="$RUNTIME_DIR/scoped-kubeconfig.yaml"
GUARDIAN_PLUGIN_DIR="$RUNTIME_DIR/plugins/dataops-guardian"
LOBSTER_PLUGIN_DIR="$RUNTIME_DIR/plugins/lobster"
NGINX_IMAGE="nginx:1.27.5-alpine"
PROMETHEUS_IMAGE="prom/prometheus:v2.53.5"

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-19188}"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export OPENCLAW_KIND_RECOVERY_RESUME_FILE="$RUNTIME_DIR/resume.json"
export LOBSTER_STATE_DIR="$RUNTIME_DIR/lobster-state"

GATEWAY_PID=""
PORT_FORWARD_PID=""
CLUSTER_CREATED=false

wait_for_tcp_port() {
  local port="$1"
  local label="$2"
  for _ in $(seq 1 480); do
    if (exec 3<>"/dev/tcp/127.0.0.1/${port}") 2>/dev/null; then
      exec 3>&-
      exec 3<&-
      return 0
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
  if ! wait_for_tcp_port "$OPENCLAW_GATEWAY_PORT" "Gateway"; then
    tail -n 200 "$log_file" >&2 || true
    return 1
  fi
}

stop_gateway() {
  if [[ -n "$GATEWAY_PID" ]] && kill -0 "$GATEWAY_PID" 2>/dev/null; then
    kill "$GATEWAY_PID"
    wait "$GATEWAY_PID" || true
  fi
  GATEWAY_PID=""
}

stop_port_forward() {
  if [[ -n "$PORT_FORWARD_PID" ]] && kill -0 "$PORT_FORWARD_PID" 2>/dev/null; then
    kill "$PORT_FORWARD_PID"
    wait "$PORT_FORWARD_PID" || true
  fi
  PORT_FORWARD_PID=""
}

delete_cluster() {
  if [[ "$CLUSTER_CREATED" == true ]]; then
    kind delete cluster --name "$CLUSTER_NAME" >/dev/null
    CLUSTER_CREATED=false
  fi
}

cleanup() {
  stop_gateway
  stop_port_forward
  delete_cluster
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-kind-prometheus-recovery.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap cleanup EXIT

run_rpc() {
  GUARDIAN_KUBERNETES_CONFIG_JSON="$KUBERNETES_CONFIG_JSON" \
    node "$ROOT_DIR/scripts/kind-prometheus-recovery-rpc.mjs" "$1"
}

query_prometheus_value() {
  GUARDIAN_PROOF_PROMETHEUS_URL="http://127.0.0.1:${PROMETHEUS_PORT}" \
  GUARDIAN_PROOF_PROMETHEUS_QUERY="$GUARDIAN_STEP4_PROMETHEUS_QUERY" \
    node -e '
      const url = new URL("/api/v1/query", process.env.GUARDIAN_PROOF_PROMETHEUS_URL);
      url.searchParams.set("query", process.env.GUARDIAN_PROOF_PROMETHEUS_QUERY);
      const response = await fetch(url);
      if (!response.ok) process.exit(2);
      const payload = await response.json();
      const result = payload?.data?.result;
      if (payload?.status !== "success" || !Array.isArray(result) || result.length !== 1) process.exit(3);
      process.stdout.write(String(result[0]?.value?.[1]));
    '
}

wait_for_prometheus_value() {
  local expected="$1"
  local label="$2"
  local value=""
  for _ in $(seq 1 120); do
    value="$(query_prometheus_value 2>/dev/null || true)"
    if [[ "$value" == "$expected" || "$value" == "${expected}.0" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not reach Prometheus value $expected (last value: ${value:-missing})" >&2
  return 1
}

mkdir -p "$RUNTIME_DIR" "$OPENCLAW_STATE_DIR"
cd "$ROOT_DIR"
npm run build

# OpenClaw rejects world-writable plugin roots, so stage only proof-owned
# plugin copies beneath /tmp. No source or credential is written to the repo.
mkdir -p "$GUARDIAN_PLUGIN_DIR" "$LOBSTER_PLUGIN_DIR"
cp "$ROOT_DIR/package.json" "$ROOT_DIR/openclaw.plugin.json" "$GUARDIAN_PLUGIN_DIR/"
cp -R "$ROOT_DIR/dist" "$GUARDIAN_PLUGIN_DIR/dist"
ln -s "$ROOT_DIR/node_modules" "$GUARDIAN_PLUGIN_DIR/node_modules"
cp -R "$ROOT_DIR/node_modules/@openclaw/lobster/." "$LOBSTER_PLUGIN_DIR/"

# --- 1. Isolated cluster and pinned proof images. ---
kind create cluster \
  --name "$CLUSTER_NAME" \
  --kubeconfig "$ADMIN_KUBECONFIG" \
  --wait 120s
CLUSTER_CREATED=true
# Pull directly into the kind node's containerd image store. Docker Desktop's
# containerd-backed host image store can retain a multi-platform manifest while
# only materializing the current platform. `kind load docker-image` then imports
# that incomplete index with `--all-platforms` and fails on a missing digest.
# Pulling through the node's CRI resolves only the node platform and keeps the
# proof independent of the host Docker image-store implementation.
docker exec "${CLUSTER_NAME}-control-plane" crictl pull "$NGINX_IMAGE" >/dev/null
docker exec "${CLUSTER_NAME}-control-plane" crictl pull "$PROMETHEUS_IMAGE" >/dev/null
kubectl --kubeconfig "$ADMIN_KUBECONFIG" create namespace "$NAMESPACE"

# --- 2. Real workload: revision 1 exports a healthy metric. ---
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create configmap payments-metrics-healthy \
  --from-literal=metrics=$'# HELP payment_success_rate Proof success ratio\n# TYPE payment_success_rate gauge\npayment_success_rate{service="payments",environment="proof"} 1\n'
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create configmap payments-metrics-unhealthy \
  --from-literal=metrics=$'# HELP payment_success_rate Proof success ratio\n# TYPE payment_success_rate gauge\npayment_success_rate{service="payments",environment="proof"} 0.7\n'

kubectl --kubeconfig "$ADMIN_KUBECONFIG" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $DEPLOYMENT
  namespace: $NAMESPACE
spec:
  replicas: 1
  revisionHistoryLimit: 5
  selector:
    matchLabels:
      app: $DEPLOYMENT
  template:
    metadata:
      labels:
        app: $DEPLOYMENT
    spec:
      containers:
        - name: payments
          image: $NGINX_IMAGE
          imagePullPolicy: IfNotPresent
          ports:
            - name: http
              containerPort: 80
          readinessProbe:
            httpGet:
              path: /metrics
              port: http
            periodSeconds: 1
          volumeMounts:
            - name: metrics
              mountPath: /usr/share/nginx/html/metrics
              subPath: metrics
      volumes:
        - name: metrics
          configMap:
            name: payments-metrics-healthy
---
apiVersion: v1
kind: Service
metadata:
  name: $DEPLOYMENT
  namespace: $NAMESPACE
spec:
  selector:
    app: $DEPLOYMENT
  ports:
    - name: http
      port: 80
      targetPort: http
EOF
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=120s

# --- 3. Real Prometheus scraping the workload Service every second. ---
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create configmap prometheus-step4-config --from-file=prometheus.yml=/dev/stdin <<EOF
global:
  scrape_interval: 1s
  evaluation_interval: 1s
scrape_configs:
  - job_name: payments-step4
    static_configs:
      - targets: ["$DEPLOYMENT.$NAMESPACE.svc.cluster.local:80"]
EOF
kubectl --kubeconfig "$ADMIN_KUBECONFIG" apply -f - <<EOF
apiVersion: apps/v1
kind: Deployment
metadata:
  name: $PROMETHEUS_SERVICE
  namespace: $NAMESPACE
spec:
  replicas: 1
  selector:
    matchLabels:
      app: $PROMETHEUS_SERVICE
  template:
    metadata:
      labels:
        app: $PROMETHEUS_SERVICE
    spec:
      containers:
        - name: prometheus
          image: $PROMETHEUS_IMAGE
          imagePullPolicy: IfNotPresent
          args:
            - --config.file=/etc/prometheus/prometheus.yml
            - --storage.tsdb.path=/prometheus
          ports:
            - name: http
              containerPort: 9090
          readinessProbe:
            httpGet:
              path: /-/ready
              port: http
            periodSeconds: 1
          volumeMounts:
            - name: config
              mountPath: /etc/prometheus
      volumes:
        - name: config
          configMap:
            name: prometheus-step4-config
---
apiVersion: v1
kind: Service
metadata:
  name: $PROMETHEUS_SERVICE
  namespace: $NAMESPACE
spec:
  selector:
    app: $PROMETHEUS_SERVICE
  ports:
    - name: http
      port: 9090
      targetPort: http
EOF
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$PROMETHEUS_SERVICE" --timeout=120s
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  port-forward service/"$PROMETHEUS_SERVICE" "${PROMETHEUS_PORT}:9090" \
  >"$RUNTIME_DIR/prometheus-port-forward.log" 2>&1 &
PORT_FORWARD_PID=$!
wait_for_tcp_port "$PROMETHEUS_PORT" "Prometheus port-forward"
wait_for_prometheus_value "1" "healthy revision 1"

# --- 4. Revision 2 degrades the real scraped metric to 0.7. ---
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  patch deployment "$DEPLOYMENT" --type=json \
  -p='[{"op":"replace","path":"/spec/template/spec/volumes/0/configMap/name","value":"payments-metrics-unhealthy"}]'
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=120s
wait_for_prometheus_value "0.7" "degraded revision 2"
REPLICASET_COUNT="$(
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
    get replicasets.apps -l app="$DEPLOYMENT" -o name | wc -l | tr -d ' '
)"
if [[ "$REPLICASET_COUNT" -lt 2 ]]; then
  echo "expected two workload ReplicaSets, found $REPLICASET_COUNT" >&2
  exit 1
fi

# --- 5. Scoped write/read credential for only the workload Deployment. ---
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create serviceaccount guardian-step4
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create role guardian-step4-deployment \
  --verb=get,patch --resource=deployments.apps --resource-name="$DEPLOYMENT"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create role guardian-step4-replicasets \
  --verb=get,list --resource=replicasets.apps
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create rolebinding guardian-step4-deployment \
  --role=guardian-step4-deployment --serviceaccount="$NAMESPACE:guardian-step4"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  create rolebinding guardian-step4-replicasets \
  --role=guardian-step4-replicasets --serviceaccount="$NAMESPACE:guardian-step4"

GUARDIAN_STEP4_SERVICE_ACCOUNT_TOKEN="$(
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
    create token guardian-step4 --duration=2h
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
      token: $GUARDIAN_STEP4_SERVICE_ACCOUNT_TOKEN
contexts:
  - name: $CLUSTER_NAME
    context:
      cluster: $CLUSTER_NAME
      user: $CLUSTER_NAME
      namespace: $NAMESPACE
current-context: $CLUSTER_NAME
EOF
chmod 600 "$SCOPED_KUBECONFIG"
unset GUARDIAN_STEP4_SERVICE_ACCOUNT_TOKEN

KUBERNETES_CONFIG_JSON="$(
  node -e '
    const [clusterId, kubeconfigPath, namespace, deployment, query] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({
      clusterId,
      kubeconfigPath,
      allowlist: [{
        namespace,
        deployment,
        recovery: {
          prometheusQuery: query,
          comparator: "gte",
          threshold: 0.95,
          maxSampleAgeSeconds: 30,
        },
      }],
    }));
  ' "$CLUSTER_NAME" "$SCOPED_KUBECONFIG" "$NAMESPACE" "$DEPLOYMENT" \
    "$GUARDIAN_STEP4_PROMETHEUS_QUERY"
)"

# --- 6. Gateway configuration. Endpoint/query/policy remain admin-owned. ---
PLUGIN_LOAD_PATHS="$(
  node -e 'process.stdout.write(JSON.stringify(process.argv.slice(1)))' \
    "$GUARDIAN_PLUGIN_DIR" "$LOBSTER_PLUGIN_DIR"
)"
"$ROOT_DIR/node_modules/.bin/openclaw" config set plugins.load.paths "$PLUGIN_LOAD_PATHS" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set plugins.entries.dataops-guardian.enabled true >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set plugins.entries.lobster.enabled true >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.mode local >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set gateway.port "$OPENCLAW_GATEWAY_PORT" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  plugins.entries.dataops-guardian.config.prometheusBaseUrl \
  "http://127.0.0.1:${PROMETHEUS_PORT}" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  plugins.entries.dataops-guardian.config.prometheusTimeoutMs 5000 >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set \
  "plugins.entries.dataops-guardian.config.kubernetes" "$KUBERNETES_CONFIG_JSON" >/dev/null
"$ROOT_DIR/node_modules/.bin/openclaw" config set tools.alsoAllow '["lobster"]' >/dev/null

start_gateway "$RUNTIME_DIR/gateway-1.log"

# --- 7. Real degraded evidence -> approval -> rollback; identical replay is a no-op. ---
PREPARE_JSON="$(run_rpc prepare)"
ROLLBACK_JSON="$(run_rpc rollback)"
REPLAY_ROLLBACK_JSON="$(run_rpc replay-rollback)"

# Crash after external mutation and before result persistence.
stop_gateway
start_gateway "$RUNTIME_DIR/gateway-2.log"
RECONCILE_JSON="$(run_rpc reconcile)"

# --- 8. Deployment must converge and real Prometheus must scrape 1.0. ---
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=120s
wait_for_prometheus_value "1" "post-rollback workload"
RECOVERY_JSON="$(run_rpc verify-recovery)"
RECOVERY_REPLAY_JSON="$(run_rpc replay-recovery)"

# A fresh Gateway process must read the durable completed state.
stop_gateway
start_gateway "$RUNTIME_DIR/gateway-3.log"
SHOW_JSON="$(run_rpc show)"
stop_gateway

delete_cluster

node -e '
  const [prepare, rollback, replay, reconcile, recovery, recoveryReplay, show] =
    process.argv.slice(1).map((value) => JSON.parse(value));
  if (show.state.stage !== "completed") throw new Error(`restart readback stage=${show.state.stage}`);
  const summary = {
    ok: true,
    proof: "kind-prometheus-dual-recovery",
    degradedMetricObserved: prepare.degradedMetric,
    degradedClassification: prepare.classification,
    productionApprovalEntry: prepare.approvalEntry,
    rollbackDecision: rollback.decision,
    rollbackMutationDispatchCount: 1,
    rollbackReplayDecision: replay.decision,
    rollbackReplayGenerationUnchanged: replay.generationUnchanged,
    restartReconciliation: reconcile.externalOutcome,
    deploymentHealthy: recovery.deploymentHealthy,
    desiredReplicas: recovery.desiredReplicas,
    availableReplicas: recovery.availableReplicas,
    prometheusHealthy: recovery.prometheusHealthy,
    prometheusRecoveredValue: recovery.prometheusValue,
    prometheusThreshold: recovery.prometheusThreshold,
    recoveryEvidenceSource: recovery.evidenceSource,
    recoveryReplayBlocked: recoveryReplay.blocked,
    incidentCompleted: recovery.incidentStage === "completed",
    completedStateSurvivedGatewayRestart: show.state.stage === "completed",
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
' "$PREPARE_JSON" "$ROLLBACK_JSON" "$REPLAY_ROLLBACK_JSON" \
  "$RECONCILE_JSON" "$RECOVERY_JSON" "$RECOVERY_REPLAY_JSON" "$SHOW_JSON"
