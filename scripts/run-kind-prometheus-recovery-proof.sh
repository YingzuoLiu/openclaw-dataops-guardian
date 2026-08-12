#!/usr/bin/env bash
set -Eeuo pipefail

# Steps 4-5: real kind Deployment rollback plus Prometheus recovery proof.
# Requires Docker, kind, kubectl, and network access to pull the pinned proof
# images. All cluster state, credentials, OpenClaw state, and port forwards are
# isolated under a proof-owned temporary directory and removed on exit.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/guardian-kind-prometheus-recovery.XXXXXX")"
FINAL_DEMO="${GUARDIAN_FINAL_DEMO:-0}"
CURRENT_PHASE="initialization"
PROGRESS_FD="${GUARDIAN_FINAL_PROGRESS_FD:-2}"

# The proof loads Guardian and Lobster explicitly. Unrelated bundled extensions
# are not part of the safety matrix and can appear world-writable on DrvFS.
export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1

# Keep the live acceptance proof isolated from any caller-level OpenClaw
# profile. OPENCLAW_STATE_DIR is assigned to the run-owned directory below.
unset OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_HOME

progress() {
  printf '[demo:kind] %s\n' "$1" >&"$PROGRESS_FD"
}
RUN_SUFFIX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(4).toString("hex"))')"
if [[ "$FINAL_DEMO" == "1" ]]; then
  read -r DEFAULT_GATEWAY_PORT DEFAULT_PROMETHEUS_PORT DEFAULT_BRIDGE_PORT < <(
    node -e '
      const net = require("node:net");
      const servers = Array.from({ length: 3 }, () => net.createServer());
      Promise.all(servers.map((server) => new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      }))).then(async (ports) => {
        await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
        process.stdout.write(`${ports.join(" ")}\n`);
      });
    '
  )
  DEFAULT_CLUSTER_NAME="guardian-final-${RUN_SUFFIX}"
else
  DEFAULT_GATEWAY_PORT="19188"
  DEFAULT_PROMETHEUS_PORT="19091"
  DEFAULT_BRIDGE_PORT="19189"
  DEFAULT_CLUSTER_NAME="guardian-step4-kind"
fi
CLUSTER_NAME="${GUARDIAN_STEP4_CLUSTER_NAME:-$DEFAULT_CLUSTER_NAME}"
export GUARDIAN_STEP4_NAMESPACE="${GUARDIAN_STEP4_NAMESPACE:-guardian-step4}"
export GUARDIAN_STEP4_DEPLOYMENT="${GUARDIAN_STEP4_DEPLOYMENT:-payments-step4}"
# Keep the proof query single-series even after the workload is deliberately
# scaled to zero. The verifier treats missing/ambiguous telemetry as an
# indeterminate Tool failure; this administrator-owned expression instead
# turns absence into a determinate unhealthy value for the live fault case.
export GUARDIAN_STEP4_PROMETHEUS_QUERY='max(payment_success_rate{service="payments",environment="proof"}) or vector(0)'
NAMESPACE="$GUARDIAN_STEP4_NAMESPACE"
DEPLOYMENT="$GUARDIAN_STEP4_DEPLOYMENT"
PROMETHEUS_SERVICE="prometheus-step4"
OTHER_DEPLOYMENT="other-step4"
PROMETHEUS_PORT="${GUARDIAN_STEP4_PROMETHEUS_PORT:-$DEFAULT_PROMETHEUS_PORT}"
BRIDGE_PORT="${ALERTMANAGER_BRIDGE_PORT:-$DEFAULT_BRIDGE_PORT}"
ADMIN_KUBECONFIG="$RUNTIME_DIR/admin-kubeconfig.yaml"
SCOPED_KUBECONFIG="$RUNTIME_DIR/scoped-kubeconfig.yaml"
GUARDIAN_PLUGIN_DIR="$RUNTIME_DIR/plugins/dataops-guardian"
LOBSTER_PLUGIN_DIR="$RUNTIME_DIR/plugins/lobster"
BRIDGE_STATE_DIR="$RUNTIME_DIR/bridge-state"
KIND_NODE_IMAGE="${GUARDIAN_KIND_NODE_IMAGE:-kindest/node:v1.33.1@sha256:050072256b9a903bd914c0b2866828150cb229cea0efe5892e2b644d5dd3b34f}"
if [[ "$FINAL_DEMO" == "1" ]]; then
  NGINX_SOURCE_IMAGE="${GUARDIAN_NGINX_IMAGE:-nginx:1.27.5-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10}"
  PROMETHEUS_SOURCE_IMAGE="${GUARDIAN_PROMETHEUS_IMAGE:-prom/prometheus:v2.53.5@sha256:7a34573f0b9c952286b33d537f233cd5b708e12263733aa646e50c33f598f16c}"
  NGINX_IMAGE="guardian-proof/nginx:${RUN_SUFFIX}"
  PROMETHEUS_IMAGE="guardian-proof/prometheus:${RUN_SUFFIX}"
  PROOF_IMAGE_PULL_POLICY="Never"
else
  NGINX_SOURCE_IMAGE="nginx:1.27.5-alpine"
  PROMETHEUS_SOURCE_IMAGE="prom/prometheus:v2.53.5"
  NGINX_IMAGE="$NGINX_SOURCE_IMAGE"
  PROMETHEUS_IMAGE="$PROMETHEUS_SOURCE_IMAGE"
  PROOF_IMAGE_PULL_POLICY="IfNotPresent"
fi

export OPENCLAW_STATE_DIR="$RUNTIME_DIR/openclaw"
export OPENCLAW_GATEWAY_PORT="${OPENCLAW_GATEWAY_PORT:-$DEFAULT_GATEWAY_PORT}"
export OPENCLAW_GATEWAY_TOKEN
OPENCLAW_GATEWAY_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export OPENCLAW_KIND_RECOVERY_RESUME_FILE="$RUNTIME_DIR/resume.json"
export OPENCLAW_KIND_RECOVERY_AMBIGUOUS_FILE="$RUNTIME_DIR/ambiguous.json"
export LOBSTER_STATE_DIR="$RUNTIME_DIR/lobster-state"
export OPENCLAW_GATEWAY_URL="ws://127.0.0.1:${OPENCLAW_GATEWAY_PORT}"
export ALERTMANAGER_BRIDGE_TOKEN
ALERTMANAGER_BRIDGE_TOKEN="$(
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
)"
export ALERTMANAGER_BRIDGE_URL="http://127.0.0.1:${BRIDGE_PORT}"
export ALERTMANAGER_BRIDGE_STATE_DIR="$BRIDGE_STATE_DIR"

GATEWAY_PID=""
CURRENT_GATEWAY_LOG=""
PORT_FORWARD_PID=""
BRIDGE_PID=""
CLUSTER_CREATED=false
CREATED_LOCAL_IMAGES=()

failed() {
  local status=$?
  trap - ERR
  echo "kind safety proof failed during ${CURRENT_PHASE}" >&2
  if [[ -n "$CURRENT_GATEWAY_LOG" && -f "$CURRENT_GATEWAY_LOG" ]]; then
    echo "last Gateway diagnostic lines:" >&2
    tail -n 120 "$CURRENT_GATEWAY_LOG" >&2 || true
  fi
  exit "$status"
}

wait_for_tcp_port() {
  local port="$1"
  local label="$2"
  local pid="$3"
  local log_file="$4"
  local probe_fd
  for _ in $(seq 1 480); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "$label process exited before becoming ready" >&2
      tail -n 100 "$log_file" >&2 || true
      return 1
    fi
    if { exec {probe_fd}<>"/dev/tcp/127.0.0.1/${port}"; } 2>/dev/null; then
      exec {probe_fd}>&-
      sleep 0.1
      if kill -0 "$pid" 2>/dev/null; then
        return 0
      fi
      echo "$label process exited after the port probe" >&2
      tail -n 100 "$log_file" >&2 || true
      return 1
    fi
    sleep 0.25
  done
  echo "$label did not become ready" >&2
  tail -n 100 "$log_file" >&2 || true
  return 1
}

assert_proof_ports_available() {
  GUARDIAN_PROOF_PORTS="${OPENCLAW_GATEWAY_PORT},${PROMETHEUS_PORT},${BRIDGE_PORT}" \
    node -e '
      const net = require("node:net");
      const ports = process.env.GUARDIAN_PROOF_PORTS.split(",").map(Number);
      if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new Error("proof ports must be valid TCP port numbers");
      }
      if (new Set(ports).size !== ports.length) {
        throw new Error("proof ports must be distinct");
      }
      const servers = ports.map(() => net.createServer());
      (async () => {
        try {
          await Promise.all(servers.map((server, index) => new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(ports[index], "127.0.0.1", resolve);
          })));
        } finally {
          await Promise.allSettled(servers.map((server) => new Promise((resolve) => {
            server.close(() => resolve());
          })));
        }
      })();
    '
}

start_gateway() {
  local log_file="$1"
  CURRENT_GATEWAY_LOG="$log_file"
  (
    cd "$GUARDIAN_PLUGIN_DIR"
    exec "$ROOT_DIR/node_modules/.bin/openclaw" gateway run \
      --port "$OPENCLAW_GATEWAY_PORT" \
      --bind loopback \
      --auth token \
      --allow-unconfigured
  ) >"$log_file" 2>&1 &
  GATEWAY_PID=$!
  if ! wait_for_tcp_port "$OPENCLAW_GATEWAY_PORT" "Gateway" "$GATEWAY_PID" "$log_file"; then
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

start_bridge() {
  local log_file="$1"
  mkdir -p "$BRIDGE_STATE_DIR"
  ALERTMANAGER_BRIDGE_HOST=127.0.0.1 \
  ALERTMANAGER_BRIDGE_PORT="$BRIDGE_PORT" \
  ALERTMANAGER_BRIDGE_TOKEN="$ALERTMANAGER_BRIDGE_TOKEN" \
  ALERTMANAGER_BRIDGE_STATE_DIR="$BRIDGE_STATE_DIR" \
  OPENCLAW_GATEWAY_URL="$OPENCLAW_GATEWAY_URL" \
  OPENCLAW_GATEWAY_TOKEN="$OPENCLAW_GATEWAY_TOKEN" \
    node "$ROOT_DIR/dist/alertmanager/http-bridge/run.js" >"$log_file" 2>&1 &
  BRIDGE_PID=$!
  if ! wait_for_tcp_port "$BRIDGE_PORT" "Alertmanager bridge" "$BRIDGE_PID" "$log_file"; then
    tail -n 100 "$log_file" >&2 || true
    return 1
  fi
}

stop_bridge() {
  if [[ -n "$BRIDGE_PID" ]] && kill -0 "$BRIDGE_PID" 2>/dev/null; then
    kill -TERM "$BRIDGE_PID"
    wait "$BRIDGE_PID" || true
  fi
  BRIDGE_PID=""
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

remove_local_images() {
  if command -v docker >/dev/null 2>&1; then
    for image in "${CREATED_LOCAL_IMAGES[@]}"; do
      docker image rm "$image" >/dev/null 2>&1 || true
    done
  fi
  CREATED_LOCAL_IMAGES=()
}

cleanup() {
  stop_bridge
  stop_gateway
  stop_port_forward
  delete_cluster
  remove_local_images
  if [[ -d "$RUNTIME_DIR" && "$RUNTIME_DIR" == "${TMPDIR:-/tmp}"/guardian-kind-prometheus-recovery.* ]]; then
    find "$RUNTIME_DIR" -depth -delete
  fi
}
trap failed ERR
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

query_prometheus_sample() {
  GUARDIAN_PROOF_PROMETHEUS_URL="http://127.0.0.1:${PROMETHEUS_PORT}" \
  GUARDIAN_PROOF_PROMETHEUS_QUERY="$GUARDIAN_STEP4_PROMETHEUS_QUERY" \
    node -e '
      const url = new URL("/api/v1/query", process.env.GUARDIAN_PROOF_PROMETHEUS_URL);
      url.searchParams.set("query", process.env.GUARDIAN_PROOF_PROMETHEUS_QUERY);
      const response = await fetch(url);
      if (!response.ok) process.exit(2);
      const payload = await response.json();
      const sample = payload?.data?.result?.[0]?.value;
      if (payload?.status !== "success" || payload?.data?.result?.length !== 1 || !sample) process.exit(3);
      process.stdout.write(JSON.stringify({
        value: Number(sample[1]),
        observedAt: new Date(Number(sample[0]) * 1_000).toISOString(),
      }));
    '
}

wait_for_prometheus_value_after() {
  local expected="$1"
  local not_before="$2"
  local label="$3"
  local sample=""
  for _ in $(seq 1 120); do
    sample="$(query_prometheus_sample 2>/dev/null || true)"
    if [[ -n "$sample" ]] && EXPECTED="$expected" NOT_BEFORE="$not_before" SAMPLE="$sample" \
      node -e '
        const sample = JSON.parse(process.env.SAMPLE);
        const valueMatches = sample.value === Number(process.env.EXPECTED);
        const timeMatches = Date.parse(sample.observedAt) > Date.parse(process.env.NOT_BEFORE);
        process.exit(valueMatches && timeMatches ? 0 : 1);
      '; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not produce value $expected after $not_before" >&2
  return 1
}

kind_node_platform() {
  case "$(docker exec "${CLUSTER_NAME}-control-plane" uname -m)" in
    x86_64)
      printf '%s' 'linux/amd64'
      ;;
    aarch64 | arm64)
      printf '%s' 'linux/arm64'
      ;;
    *)
      echo "Unsupported kind node architecture" >&2
      return 1
      ;;
  esac
}

containerd_image_ref() {
  local image="$1"
  local first_component="${image%%/*}"
  if [[ "$image" != */* ]]; then
    printf 'docker.io/library/%s' "$image"
  elif [[ "$first_component" != *.* && "$first_component" != *:* && "$first_component" != "localhost" ]]; then
    printf 'docker.io/%s' "$image"
  else
    printf '%s' "$image"
  fi
}

load_proof_image() {
  local source_image="$1"
  local runtime_image="$2"
  local platform="$3"
  local node="${CLUSTER_NAME}-control-plane"
  local containerd_ref
  local ready_ref

  # Docker Desktop handles host proxy routing, including loopback proxies that
  # are unreachable from the kind node. Its containerd image store can export
  # an OCI index that references attestation or other-platform blobs that are
  # not present in the archive. kind imports every platform and fails on
  # those absent blobs, so import only the platform actually used by this node.
  docker pull --platform "$platform" "$source_image" >/dev/null
  if [[ "$runtime_image" != "$source_image" ]]; then
    if docker image inspect "$runtime_image" >/dev/null 2>&1; then
      echo "refusing to overwrite an existing local proof image: $runtime_image" >&2
      return 1
    fi
    docker tag "$source_image" "$runtime_image"
    CREATED_LOCAL_IMAGES+=("$runtime_image")
  fi
  docker image save "$runtime_image" | docker exec --privileged -i "$node" \
    ctr --namespace=k8s.io images import \
      --platform "$platform" \
      --digests \
      --snapshotter=overlayfs - >/dev/null
  containerd_ref="$(containerd_image_ref "$runtime_image")"
  ready_ref="$(docker exec "$node" ctr --namespace=k8s.io images check \
    --quiet \
    --snapshotter=overlayfs \
    "name==$containerd_ref")"
  if [[ "$ready_ref" != "$containerd_ref" ]]; then
    echo "imported proof image is not ready in kind: $containerd_ref" >&2
    return 1
  fi
}

CURRENT_PHASE="final-demo prerequisite checks"
progress "$CURRENT_PHASE"
if [[ "$FINAL_DEMO" == "1" ]]; then
  : "${GUARDIAN_FINAL_REPORT_PATH:?GUARDIAN_FINAL_REPORT_PATH is required for the final demo}"
  if [[ -e "$GUARDIAN_FINAL_REPORT_PATH" || -L "$GUARDIAN_FINAL_REPORT_PATH" ]]; then
    echo "final demo refuses to overwrite an existing report path" >&2
    exit 1
  fi
  for command in docker kind kubectl node npm; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "final demo prerequisite is missing: $command" >&2
      exit 1
    fi
  done
  if ! docker info >/dev/null 2>&1; then
    echo "final demo requires a reachable Docker daemon" >&2
    exit 1
  fi
  if kind get clusters 2>/dev/null | grep -Fxq "$CLUSTER_NAME"; then
    echo "final demo refuses to reuse or delete an existing kind cluster: $CLUSTER_NAME" >&2
    exit 1
  fi
  for image in "$KIND_NODE_IMAGE" "$NGINX_SOURCE_IMAGE" "$PROMETHEUS_SOURCE_IMAGE"; do
    if [[ ! "$image" =~ @sha256:[a-f0-9]{64}$ ]]; then
      echo "final demo images must be pinned by sha256 digest: $image" >&2
      exit 1
    fi
  done
fi

assert_proof_ports_available

CURRENT_PHASE="build and plugin staging"
progress "$CURRENT_PHASE"
mkdir -p "$RUNTIME_DIR" "$OPENCLAW_STATE_DIR"
cd "$ROOT_DIR"
npm run build

# OpenClaw rejects world-writable plugin roots, so stage only proof-owned
# plugin copies beneath /tmp. No source or credential is written to the repo.
mkdir -p \
  "$GUARDIAN_PLUGIN_DIR/workflows" \
  "$GUARDIAN_PLUGIN_DIR/scripts" \
  "$LOBSTER_PLUGIN_DIR"
cp "$ROOT_DIR/package.json" "$ROOT_DIR/openclaw.plugin.json" "$GUARDIAN_PLUGIN_DIR/"
cp -R "$ROOT_DIR/dist" "$GUARDIAN_PLUGIN_DIR/dist"
cp "$ROOT_DIR/workflows/incident-remediation.lobster" \
  "$GUARDIAN_PLUGIN_DIR/workflows/"
cp "$ROOT_DIR/scripts/remediation-step.mjs" "$GUARDIAN_PLUGIN_DIR/scripts/"
ln -s "$ROOT_DIR/node_modules" "$GUARDIAN_PLUGIN_DIR/node_modules"
cp -R "$ROOT_DIR/node_modules/@openclaw/lobster/." "$LOBSTER_PLUGIN_DIR/"

# --- 1. Isolated cluster and pinned proof images. ---
CURRENT_PHASE="kind cluster creation"
progress "$CURRENT_PHASE"
KIND_CREATE_ARGS=(
  --name "$CLUSTER_NAME"
  --kubeconfig "$ADMIN_KUBECONFIG"
  --wait 120s
)
if [[ "$FINAL_DEMO" == "1" ]]; then
  KIND_CREATE_ARGS+=(--image "$KIND_NODE_IMAGE")
  # The final name is run-unique, so cleanup may safely remove a partially
  # created cluster if kind exits before reporting success.
  CLUSTER_CREATED=true
fi
kind create cluster "${KIND_CREATE_ARGS[@]}"
CLUSTER_CREATED=true
CURRENT_PHASE="pinned proof image import"
progress "$CURRENT_PHASE"
NODE_PLATFORM="$(kind_node_platform)"
load_proof_image "$NGINX_SOURCE_IMAGE" "$NGINX_IMAGE" "$NODE_PLATFORM"
load_proof_image "$PROMETHEUS_SOURCE_IMAGE" "$PROMETHEUS_IMAGE" "$NODE_PLATFORM"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" create namespace "$NAMESPACE"

# --- 2. Real workload: revision 1 exports a healthy metric. ---
CURRENT_PHASE="healthy workload bootstrap"
progress "$CURRENT_PHASE"
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
          imagePullPolicy: $PROOF_IMAGE_PULL_POLICY
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
CURRENT_PHASE="Prometheus bootstrap"
progress "$CURRENT_PHASE"
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
          imagePullPolicy: $PROOF_IMAGE_PULL_POLICY
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
wait_for_tcp_port "$PROMETHEUS_PORT" "Prometheus port-forward" \
  "$PORT_FORWARD_PID" "$RUNTIME_DIR/prometheus-port-forward.log"
wait_for_prometheus_value "1" "healthy revision 1"

# --- 4. Revision 2 degrades the real scraped metric to 0.7. ---
CURRENT_PHASE="degraded metric observation"
progress "$CURRENT_PHASE"
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
if [[ "$FINAL_DEMO" == "1" ]]; then
  kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
    create deployment "$OTHER_DEPLOYMENT" --image="$NGINX_IMAGE" --replicas=0
fi

# --- 5. Scoped write/read credential for only the workload Deployment. ---
CURRENT_PHASE="scoped Kubernetes authorization setup"
progress "$CURRENT_PHASE"
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
CURRENT_PHASE="Gateway startup"
progress "$CURRENT_PHASE"
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

if [[ "$FINAL_DEMO" != "1" ]]; then
  # Step 4 component proof retained for compatibility.
  PREPARE_JSON="$(run_rpc prepare)"
  ROLLBACK_JSON="$(run_rpc rollback)"
  REPLAY_ROLLBACK_JSON="$(run_rpc replay-rollback)"

  stop_gateway
  start_gateway "$RUNTIME_DIR/gateway-2.log"
  RECONCILE_JSON="$(run_rpc reconcile)"

  kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
    rollout status deployment "$DEPLOYMENT" --timeout=120s
  wait_for_prometheus_value "1" "post-rollback workload"
  RECOVERY_JSON="$(run_rpc verify-recovery)"

  # Completion is not accepted until a fresh Gateway process can read it and
  # the recovery Tool gate still blocks an identical replay.
  stop_gateway
  start_gateway "$RUNTIME_DIR/gateway-3.log"
  RECOVERY_REPLAY_JSON="$(run_rpc replay-recovery)"
  SHOW_JSON="$(run_rpc show)"
  stop_gateway
  delete_cluster

  node -e '
    const [prepare, rollback, replay, reconcile, recovery, recoveryReplay, show] =
      process.argv.slice(1).map((value) => JSON.parse(value));
    if (show.state.stage !== "completed") throw new Error(`restart readback stage=${show.state.stage}`);
    process.stdout.write(`${JSON.stringify({
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
    }, null, 2)}\n`);
  ' "$PREPARE_JSON" "$ROLLBACK_JSON" "$REPLAY_ROLLBACK_JSON" \
    "$RECONCILE_JSON" "$RECOVERY_JSON" "$RECOVERY_REPLAY_JSON" "$SHOW_JSON"
  exit 0
fi

# --- 7. Final HTTP ingress, Tool evidence, approve/deny, and ambiguous restart. ---
CURRENT_PHASE="HTTP ingress and approval denial"
progress "$CURRENT_PHASE"
start_bridge "$RUNTIME_DIR/bridge-1.log"
PREPARE_JSON="$(run_rpc prepare-http)"
DENIED_JSON="$(run_rpc denied-approval)"
run_rpc prepare-ambiguous >/dev/null

stop_bridge
stop_gateway
CURRENT_PHASE="ambiguous restart and target authorization"
progress "$CURRENT_PHASE"
start_gateway "$RUNTIME_DIR/gateway-2.log"
start_bridge "$RUNTIME_DIR/bridge-2.log"
AMBIGUOUS_JSON="$(run_rpc reconcile-ambiguous)"
OFF_TARGET_JSON="$(run_rpc off-target)"

# --- 8. The one authorized mutation, immediate replay, and restart replay. ---
CURRENT_PHASE="authorized rollback and replay"
progress "$CURRENT_PHASE"
ROLLBACK_JSON="$(run_rpc rollback)"
REPLAY_ROLLBACK_JSON="$(run_rpc replay-rollback)"
stop_bridge
stop_gateway
start_gateway "$RUNTIME_DIR/gateway-3.log"
start_bridge "$RUNTIME_DIR/bridge-3.log"
POST_RESTART_REPLAY_JSON="$(run_rpc replay-rollback)"
CURRENT_PHASE="restart reconciliation"
progress "$CURRENT_PHASE"
RECONCILE_JSON="$(run_rpc reconcile)"

# --- 9. Resolved is not recovery; scale-to-zero must fail dual recovery. ---
CURRENT_PHASE="negative recovery verification"
progress "$CURRENT_PHASE"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=120s
wait_for_prometheus_value "1" "post-rollback workload"
RESOLVED_JSON="$(run_rpc resolved-not-recovered)"

kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  scale deployment "$DEPLOYMENT" --replicas=0
if [[ "$(kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  get deployment "$DEPLOYMENT" -o jsonpath='{.spec.replicas}')" != "0" ]]; then
  echo "workload did not scale to zero" >&2
  exit 1
fi
NEGATIVE_RECOVERY_JSON="$(run_rpc verify-negative-recovery)"
NEGATIVE_CHECKED_AT="$(
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).checkedAt)' \
    "$NEGATIVE_RECOVERY_JSON"
)"

# Only the final recovered observation is persisted. It must use a sample
# strictly newer than the scale-zero observation.
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  scale deployment "$DEPLOYMENT" --replicas=1
CURRENT_PHASE="positive dual recovery verification"
progress "$CURRENT_PHASE"
kubectl --kubeconfig "$ADMIN_KUBECONFIG" --namespace "$NAMESPACE" \
  rollout status deployment "$DEPLOYMENT" --timeout=120s
wait_for_prometheus_value_after "1" "$NEGATIVE_CHECKED_AT" "restored workload"
RECOVERY_JSON="$(run_rpc verify-recovery)"

# --- 10. A fresh Gateway must read completion and block recovery replay. ---
CURRENT_PHASE="completion restart and replay protection"
progress "$CURRENT_PHASE"
stop_bridge
stop_gateway
start_gateway "$RUNTIME_DIR/gateway-4.log"
RECOVERY_REPLAY_JSON="$(run_rpc replay-recovery)"
SHOW_JSON="$(run_rpc show)"
stop_gateway

# --- 11. Scoped credential cannot operate outside the exact authority. ---
CURRENT_PHASE="scoped RBAC denial checks"
progress "$CURRENT_PHASE"
trap - ERR
set +e
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" \
  patch deployment "$OTHER_DEPLOYMENT" --type=merge \
  -p '{"metadata":{"annotations":{"guardian-proof":"denied"}}}' \
  >/dev/null 2>"$RUNTIME_DIR/rbac-other-deployment.err"
RBAC_OTHER_DEPLOYMENT=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace default get deployments \
  >/dev/null 2>"$RUNTIME_DIR/rbac-other-namespace.err"
RBAC_OTHER_NAMESPACE=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" get secrets \
  >/dev/null 2>"$RUNTIME_DIR/rbac-secrets.err"
RBAC_SECRETS=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" \
  delete deployment "$DEPLOYMENT" \
  >/dev/null 2>"$RUNTIME_DIR/rbac-delete.err"
RBAC_DELETE=$?
kubectl --kubeconfig "$SCOPED_KUBECONFIG" --namespace "$NAMESPACE" \
  create deployment guardian-should-fail --image="$NGINX_IMAGE" \
  >/dev/null 2>"$RUNTIME_DIR/rbac-create.err"
RBAC_CREATE=$?
set -e
trap failed ERR

for pair in \
  "$RBAC_OTHER_DEPLOYMENT:rbac-other-deployment.err" \
  "$RBAC_OTHER_NAMESPACE:rbac-other-namespace.err" \
  "$RBAC_SECRETS:rbac-secrets.err" \
  "$RBAC_DELETE:rbac-delete.err" \
  "$RBAC_CREATE:rbac-create.err"; do
  exit_code="${pair%%:*}"
  error_file="${pair##*:}"
  if [[ "$exit_code" -eq 0 ]] || ! grep -qi "forbidden" "$RUNTIME_DIR/$error_file"; then
    echo "scoped RBAC request did not fail with Forbidden: $error_file" >&2
    exit 1
  fi
done
RBAC_JSON='{"otherDeploymentDenied":true,"otherNamespaceDenied":true,"secretsDenied":true,"deleteDenied":true,"createDenied":true}'

# --- 12. Explicit cleanup before releasing the sanitized report. ---
CURRENT_PHASE="explicit cleanup verification"
progress "$CURRENT_PHASE"
stop_bridge
stop_gateway
stop_port_forward
delete_cluster
if kind get clusters 2>/dev/null | grep -Fxq "$CLUSTER_NAME"; then
  echo "final demo cluster still exists after cleanup" >&2
  exit 1
fi
remove_local_images
if ! docker info >/dev/null 2>&1; then
  echo "Docker became unavailable before cleanup could be verified" >&2
  exit 1
fi
for image in "$NGINX_IMAGE" "$PROMETHEUS_IMAGE"; do
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "local proof image tag still exists after cleanup: $image" >&2
    exit 1
  fi
done
find "$ADMIN_KUBECONFIG" "$SCOPED_KUBECONFIG" -maxdepth 0 -type f -delete
if [[ -e "$ADMIN_KUBECONFIG" || -e "$SCOPED_KUBECONFIG" ]]; then
  echo "temporary kubeconfig cleanup failed" >&2
  exit 1
fi
unset OPENCLAW_GATEWAY_TOKEN ALERTMANAGER_BRIDGE_TOKEN KUBERNETES_CONFIG_JSON
CLEANUP_JSON='{"gatewayStopped":true,"bridgeStopped":true,"portForwardStopped":true,"clusterDeleted":true,"localImageTagsDeleted":true,"temporaryCredentialsDeleted":true}'

CURRENT_PHASE="sanitized kind report generation"
progress "$CURRENT_PHASE"
node scripts/final-proof-report.mjs kind \
  "$PREPARE_JSON" \
  "$DENIED_JSON" \
  "$AMBIGUOUS_JSON" \
  "$OFF_TARGET_JSON" \
  "$ROLLBACK_JSON" \
  "$REPLAY_ROLLBACK_JSON" \
  "$POST_RESTART_REPLAY_JSON" \
  "$RECONCILE_JSON" \
  "$RESOLVED_JSON" \
  "$NEGATIVE_RECOVERY_JSON" \
  "$RECOVERY_JSON" \
  "$RECOVERY_REPLAY_JSON" \
  "$SHOW_JSON" \
  "$RBAC_JSON" \
  "$CLEANUP_JSON" >"$GUARDIAN_FINAL_REPORT_PATH"
