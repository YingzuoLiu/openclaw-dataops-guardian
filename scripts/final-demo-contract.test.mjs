import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function occurrenceCount(text, needle) {
  return text.split(needle).length - 1;
}

function expectInOrder(text, needles) {
  let cursor = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, cursor + 1);
    expect(next, `missing or out-of-order contract marker: ${needle}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

function between(text, start, end) {
  const startIndex = text.indexOf(start);
  expect(startIndex, `missing contract section start: ${start}`).toBeGreaterThanOrEqual(0);
  const endIndex = text.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing contract section end: ${end}`).toBeGreaterThan(startIndex);
  return text.slice(startIndex, endIndex);
}

describe("final proof source contract", () => {
  it("keeps the replay console separate from fast and full proof commands", async () => {
    const [packageText, workflow, fast, full, contributing] = await Promise.all([
      source("package.json"),
      source(".github/workflows/ci.yml"),
      source("scripts/run-final-fast-demo.sh"),
      source("scripts/run-final-demo.sh"),
      source("CONTRIBUTING.md"),
    ]);
    const packageJson = JSON.parse(packageText);

    expect(packageJson.scripts.demo).toBe("node demo/server.mjs");
    expect(packageJson.scripts).not.toHaveProperty("demo:replay");
    expect(packageJson.scripts["demo:fast"]).toBe(
      "bash scripts/run-final-fast-demo.sh",
    );
    expect(packageJson.scripts["proof:full"]).toBe(
      "bash scripts/run-final-demo.sh",
    );
    expect(workflow).toContain("npm run --silent proof:full");
    expect(workflow).not.toContain("npm run --silent demo \\");
    expect(contributing).toContain("```bash\nnpm run proof:full\n```");
    expect(contributing).not.toContain("```bash\nnpm run demo\n```");
    expect(contributing).toContain(
      "offline `npm run demo` Console replays a checked-in sanitized artifact",
    );

    expectInOrder(fast, [
      "run-policy-registration-proof.sh",
      "run-live-hook-invocation-proof.sh",
      "run-alertmanager-http-bridge-proof.sh",
      "GUARDIAN_PROOF_DECISION=approve",
      "GUARDIAN_PROOF_DECISION=deny",
      "final-proof-report.mjs fast",
    ]);
    expect(fast).not.toMatch(/\b(?:docker|kind|kubectl)\b/);
    expect(fast).not.toContain("OPENROUTER_API_KEY");
    expect(fast).not.toContain("eval:openrouter");
    expect(fast).toContain("Array.from({ length: 8 }");
    expect(fast).toContain('`${ports.join(" ")}\\n`');
    expect(fast).toContain(
      'STAGED_GUARDIAN_DIR="$RUNTIME_DIR/plugins/dataops-guardian"',
    );
    expect(fast).toContain('cp -R "$ROOT_DIR/node_modules/@openclaw/lobster/."');
    expect(fast).toContain(
      'ln -s "$ROOT_DIR/node_modules" "$STAGED_GUARDIAN_DIR/node_modules"',
    );
    expect(fast).toContain(
      'chmod -R go-w "$STAGED_GUARDIAN_DIR" "$STAGED_LOBSTER_DIR"',
    );
    expect(fast).toContain('tail -n 120 "$CURRENT_LOG"');
    expect(fast).toContain('demo:fast failed during ${CURRENT_COMPONENT} (exit ${status})');
    expect(fast).toContain("run_component 600s npm run build");
    expect(occurrenceCount(fast, "npm run build")).toBe(1);
    expect(occurrenceCount(fast, 'GUARDIAN_PROOF_PREBUILT_STAMP="$PREBUILT_STAMP"')).toBe(5);
    expectInOrder(fast, [
      "run_component 600s npm run build",
      'cp -R "$ROOT_DIR/dist"',
      '\"$STAGED_GUARDIAN_DIR\" >\"$PREBUILT_STAMP\"',
      'CURRENT_COMPONENT="policy registration"',
    ]);
    for (const section of [
      between(fast, 'CURRENT_COMPONENT="policy registration"', 'CURRENT_COMPONENT="live Agent hook"'),
      between(fast, 'CURRENT_COMPONENT="live Agent hook"', 'CURRENT_COMPONENT="Alertmanager HTTP bridge"'),
      between(fast, 'CURRENT_COMPONENT="Alertmanager HTTP bridge"', 'CURRENT_COMPONENT="synthetic approval"'),
      between(fast, 'CURRENT_COMPONENT="synthetic approval"', 'CURRENT_COMPONENT="synthetic denial"'),
      between(fast, 'CURRENT_COMPONENT="synthetic denial"', 'CURRENT_COMPONENT="sanitized summary"'),
    ]) {
      expect(occurrenceCount(section, 'GUARDIAN_PROOF_PREBUILT_STAMP="$PREBUILT_STAMP"')).toBe(1);
    }
    expect(fast).toContain('run_component 120s env');
    expect(fast).toContain('run_component 420s env');
    expect(fast).toContain('run_component 300s env');
    expect(fast).toContain(
      "unset OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_HOME",
    );
    expect(fast).toContain("export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1");
    expect(fast).toContain("progress \"$CURRENT_COMPONENT\"");
    expect(fast).toContain(
      'GUARDIAN_PROOF_PLUGIN_DIR="$STAGED_GUARDIAN_DIR"',
    );
    expect(fast).toContain(
      'GUARDIAN_PROOF_LOBSTER_PLUGIN_DIR="$STAGED_LOBSTER_DIR"',
    );
    expect(occurrenceCount(
      fast,
      'GUARDIAN_PROOF_GATEWAY_CWD="$RUNTIME_DIR"',
    )).toBe(2);

    const [prebuiltGuard, policy, live, bridge, vertical] = await Promise.all([
      source("scripts/guardian-proof-build.sh"),
      source("scripts/run-policy-registration-proof.sh"),
      source("scripts/run-live-hook-invocation-proof.sh"),
      source("scripts/run-alertmanager-http-bridge-proof.sh"),
      source("scripts/run-vertical-slice-proof.sh"),
    ]);
    expect(prebuiltGuard).toContain('if [[ -z "$stamp" ]]');
    expect(prebuiltGuard).toContain("npm run build");
    expect(prebuiltGuard).toContain('"$plugin_dir/dist/index.js"');
    expect(prebuiltGuard).toContain(
      "prebuilt proof stamp does not match the staged plugin",
    );
    for (const component of [policy, live, bridge, vertical]) {
      expect(component).toContain("guardian-proof-build.sh");
      expect(component).toContain("guardian_build_or_verify_prebuilt");
      expect(component).toContain("--batch-json");
      expect(component).toContain("GUARDIAN_PROOF_PLUGIN_DIR");
      expect(component).toContain("plugins.load.paths");
      expect(component).toContain("plugins.entries.dataops-guardian.enabled");
    }
    expect(policy).toContain("--batch-json \"$POLICY_BATCH_JSON\"");
    expect(policy).toContain("[policy] configure");
    expect(policy).toContain("[policy] inspect");
    expect(occurrenceCount(policy, "openclaw config set")).toBe(1);
    expect(occurrenceCount(live, "openclaw config set")).toBe(1);
    expect(occurrenceCount(bridge, "openclaw\" config set")).toBe(1);
    expect(occurrenceCount(vertical, "openclaw config set")).toBe(1);
    expect(live).toContain("[live-hook] configure");
    expect(bridge).toContain("[bridge] configure");
    expect(vertical).toContain("[vertical] configure");
    expect(vertical).toContain(
      'LOBSTER_PLUGIN_DIR="${GUARDIAN_PROOF_LOBSTER_PLUGIN_DIR:-$PWD/node_modules/@openclaw/lobster}"',
    );
    expect(vertical).toContain(
      '{ path: "plugins.entries.lobster.enabled", value: true }',
    );

    expectInOrder(full, [
      "run-final-fast-demo.sh",
      "GUARDIAN_FINAL_DEMO=1",
      "run-kind-prometheus-recovery-proof.sh",
      "final-proof-report.mjs full",
    ]);
    expect(full).toContain(
      'run_component 1800s "$RUNTIME_DIR/kind.log" env',
    );
    expect(full).toContain("GUARDIAN_FINAL_PROGRESS_FD=3");
  });

  it("re-executes Windows-mounted WSL proofs from private native storage", async () => {
    const [helper, fast, full] = await Promise.all([
      source("scripts/guardian-proof-native-stage.sh"),
      source("scripts/run-final-fast-demo.sh"),
      source("scripts/run-final-demo.sh"),
    ]);

    for (const runner of [fast, full]) {
      expectInOrder(runner, [
        'ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"',
        'source "$ROOT_DIR/scripts/guardian-proof-native-stage.sh"',
        "guardian_reexec_proof_on_native_fs",
        'guardian_require_proof_source_commit "$ROOT_DIR"',
        'RUNTIME_DIR="$(mktemp -d',
      ]);
    }
    expect(helper).toContain("/mnt/[A-Za-z]/*");
    expect(helper).toContain("guardian_require_proof_source_commit");
    expect(helper).toContain("status");
    expect(helper).toContain("--porcelain=v1 --untracked-files=all");
    expect(helper).toContain('git init --quiet --template= "$destination_root"');
    expect(helper).toContain(
      '--quiet --depth=1 --no-tags "$source_root" "$source_commit"',
    );
    expect(helper).toContain("checkout --quiet --detach FETCH_HEAD");
    expect(helper).not.toContain("git archive");
    expect(helper).not.toContain("ls-files");
    expect(helper).not.toContain('printf "node_modules\\0"');
    expect(helper).toContain(
      "npm ci --ignore-scripts --no-audit --no-fund --prefer-offline",
    );
    expect(helper).toContain("GUARDIAN_PROOF_NATIVE_INSTALL_TIMEOUT");
    expect(helper).toContain("last dependency install diagnostic lines:");
    expect(helper).toContain('tail -n 120 "$install_log"');
    expect(helper).toContain('TMPDIR="$staged_tmp"');
    expect(helper).toContain("GUARDIAN_PROOF_NATIVE_STAGED=1");
    expect(helper).toContain("GUARDIAN_PROOF_FORCE_NATIVE_STAGE=0");
    expect(helper).toContain(
      'GUARDIAN_PROOF_SOURCE_COMMIT="$source_commit"',
    );
    expect(helper).not.toContain(
      '[[ "${GUARDIAN_PROOF_NATIVE_STAGED:-0}" == "1" ]]',
    );
    expectInOrder(helper, [
      "cleanup_native_stage() {",
      "trap cleanup_native_stage EXIT",
      'stage_root="$(mktemp -d',
    ]);
    expect(helper).toContain("find \"$stage_root\" -depth -delete");
  });

  it("uses one run-owned kind cluster and performs the complete live safety sequence", async () => {
    const runner = await source("scripts/run-kind-prometheus-recovery-proof.sh");

    expect(occurrenceCount(runner, "kind create cluster")).toBe(1);
    expect(runner).toContain('DEFAULT_CLUSTER_NAME="guardian-final-${RUN_SUFFIX}"');
    expect(runner).toContain(
      "final demo refuses to reuse or delete an existing kind cluster",
    );
    expect(runner).toContain(
      "final demo refuses to overwrite an existing report path",
    );
    expect(runner).toContain("KIND_CREATE_ARGS+=(--image \"$KIND_NODE_IMAGE\")");
    expect(runner).toContain("@sha256:");
    expect(runner).toMatch(/final demo images must be pinned by sha256 digest/);
    expect(runner).toContain('NGINX_IMAGE="guardian-proof/nginx:${RUN_SUFFIX}"');
    expect(runner).toContain('PROOF_IMAGE_PULL_POLICY="Never"');
    expect(runner).not.toContain('kind load docker-image "$runtime_image"');
    expect(runner).toContain('docker image save "$runtime_image"');
    expect(runner).toContain('ctr --namespace=k8s.io images import');
    expect(runner).toContain('--platform "$platform"');
    expect(runner).not.toContain("--all-platforms");
    expect(runner).toContain("ctr --namespace=k8s.io images check");
    expect(runner).toContain("--quiet");
    expect(runner).toContain("--snapshotter=overlayfs");
    expect(runner).toContain('"name==$containerd_ref"');
    expect(runner).toContain('[[ "$ready_ref" != "$containerd_ref" ]]');
    expect(runner).toContain("local proof image tag still exists after cleanup");
    expect(runner).toContain("proof ports must be distinct");
    expect(runner).toContain('kill -0 "$pid"');
    expect(runner).toContain(
      'exec {probe_fd}<>"/dev/tcp/127.0.0.1/${port}"',
    );
    expect(runner).toContain("exec {probe_fd}>&-");
    expect(runner).not.toContain('exec 3<>"/dev/tcp');
    expect(runner).not.toContain("exec 3>&-");
    expect(runner).toContain('`${ports.join(" ")}\\n`');
    expect(runner).toContain("kind safety proof failed during ${CURRENT_PHASE}");
    expect(runner).toContain("export OPENCLAW_DISABLE_BUNDLED_PLUGINS=1");
    expect(runner).toContain(
      "unset OPENCLAW_CONFIG_PATH OPENCLAW_PROFILE OPENCLAW_HOME",
    );
    expect(runner).toContain("progress \"$CURRENT_PHASE\"");
    expect(runner).toContain(
      'max(payment_success_rate{service="payments",environment="proof"}) or vector(0)',
    );
    expect(runner).toContain('tail -n 120 "$CURRENT_GATEWAY_LOG"');

    const fullRunner = await source("scripts/run-final-demo.sh");
    expect(fullRunner).toContain('tail -n 120 "$log_file"');

    expectInOrder(runner, [
      'start_bridge "$RUNTIME_DIR/bridge-1.log"',
      "run_rpc prepare-http",
      "run_rpc denied-approval",
      "run_rpc prepare-ambiguous",
      'start_gateway "$RUNTIME_DIR/gateway-2.log"',
      "run_rpc reconcile-ambiguous",
      "run_rpc off-target",
      "run_rpc rollback",
      "run_rpc replay-rollback",
      'start_gateway "$RUNTIME_DIR/gateway-3.log"',
      "run_rpc replay-rollback",
      "run_rpc reconcile",
      "run_rpc resolved-not-recovered",
      'scale deployment "$DEPLOYMENT" --replicas=0',
      "run_rpc verify-negative-recovery",
      'scale deployment "$DEPLOYMENT" --replicas=1',
      "wait_for_prometheus_value_after",
      "run_rpc verify-recovery",
      'start_gateway "$RUNTIME_DIR/gateway-4.log"',
      "run_rpc replay-recovery",
      "run_rpc show",
      "Scoped credential cannot operate outside the exact authority",
      "Explicit cleanup before releasing the sanitized report",
      "final-proof-report.mjs kind",
    ]);

    const cleanup = between(runner, "# --- 12. Explicit cleanup", "node scripts/final-proof-report.mjs kind");
    expect(cleanup).toContain("stop_bridge");
    expect(cleanup).toContain("stop_gateway");
    expect(cleanup).toContain("stop_port_forward");
    expect(cleanup).toContain("delete_cluster");
    expect(cleanup).toContain("remove_local_images");
    expect(cleanup).toContain("kind get clusters");
    expect(cleanup).toContain("temporary kubeconfig cleanup failed");
    expect(cleanup).toContain(
      "unset OPENCLAW_GATEWAY_TOKEN ALERTMANAGER_BRIDGE_TOKEN KUBERNETES_CONFIG_JSON",
    );

    for (const deniedBoundary of [
      "rbac-other-deployment.err",
      "rbac-other-namespace.err",
      "rbac-secrets.err",
      "rbac-delete.err",
      "rbac-create.err",
    ]) {
      expect(runner).toContain(deniedBoundary);
    }

    const rbac = between(
      runner,
      "# --- 11. Scoped credential cannot operate outside the exact authority.",
      "# --- 12. Explicit cleanup",
    );
    expectInOrder(rbac, ["trap - ERR", "set +e", "set -e", "trap failed ERR"]);
  });

  it("binds the final RPC proof to real ingress, Gateway Tools, Lobster, Kubernetes audit, and recovery", async () => {
    const rpc = await source("scripts/kind-prometheus-recovery-rpc.mjs");

    for (const command of [
      "prepare-http",
      "denied-approval",
      "prepare-ambiguous",
      "reconcile-ambiguous",
      "off-target",
      "rollback",
      "replay-rollback",
      "reconcile",
      "resolved-not-recovered",
      "verify-negative-recovery",
      "verify-recovery",
      "replay-recovery",
      "show",
    ]) {
      expect(rpc).toContain(`"${command}"`);
    }

    const ingress = between(rpc, "async function createHttpIncident", "async function collectEvidenceAndPropose");
    expect(ingress).toContain("postWebhook(payload, { authorized: false })");
    expect(ingress).toContain("unauthorized.status === 401");
    expect(ingress).toContain("describeIncidentState(sessionKey)) === undefined");
    expect(ingress).toContain('disposition === "created"');
    expect(ingress).toContain('disposition === "duplicate"');
    expect(ingress).toContain("state.evidence.length === 0");

    const evidence = between(rpc, "async function collectEvidenceAndPropose", "function buildIdempotencyKey");
    expect(evidence).toContain("queryPrometheus(sessionKey)");
    expect(evidence).toContain('"guardian_inspect_metric_snapshot"');
    expect(evidence).toContain('"guardian_propose_remediation"');
    expect(evidence).toContain("sample.observedAt) >= Date.parse(initialState.updatedAt");
    expect(evidence).toContain("incidentStore.persistIncidentState(sessionKey, state)");
    expect(evidence).not.toContain("inspectMetricSnapshot(");
    expect(evidence).not.toContain("proposeRemediation(");

    const denial = between(rpc, "async function deniedApproval", "async function prepareAmbiguous");
    expect(denial).toContain("approve: false");
    expect(denial).toContain('authorized.workflowStatus === "cancelled"');
    expect(denial).toContain('authorized.state.approvalStatus === "denied"');
    expect(denial).toContain('name: "guardian_rollback_deployment"');
    expect(denial).toContain('"requires an approved incident"');
    expect(denial).toContain("mutationFingerprintMatches(before, after)");

    const ambiguous = between(rpc, "async function prepareAmbiguous", "async function offTarget");
    expect(ambiguous).toContain("authorizeIncident");
    expect(ambiguous).toContain("new KubernetesDeploymentRollbackReconciler");
    expect(ambiguous).toContain('result.decision === "manual_review"');
    expect(ambiguous).toContain('result.externalOutcome === "unknown"');
    expect(ambiguous).not.toContain('name: "guardian_rollback_deployment"');

    const offTarget = between(rpc, "async function offTarget", "async function invokeRollback");
    expect(offTarget).toContain('namespace: "default"');
    expect(offTarget).toContain('deployment: "not-allowlisted"');
    expect(offTarget).toContain('name: "guardian_rollback_deployment"');
    expect(offTarget).toContain('"outside the administrator allowlist"');
    expect(offTarget).toContain("mutationFingerprintMatches(before, after)");

    const negative = between(rpc, "async function verifyNegativeRecovery", "async function verifyRecovery");
    expect(negative).toContain('"guardian_verify_deployment_recovery"');
    expect(negative).toContain('details?.decision === "not_recovered"');
    expect(negative).toContain('"desired_replicas_not_positive"');
    expect(negative).toContain('unchanged.stage === "recovery_check"');
    expect(negative).not.toContain("persistDeploymentRecoveryVerification");

    const positive = between(rpc, "async function verifyRecovery", "async function replayRecovery");
    expect(positive).toContain('name: "guardian_verify_deployment_recovery"');
    expect(positive).toContain("persistDeploymentRecoveryVerification");
    expect(positive).toContain('completed.stage === "completed"');
    expect(positive).toContain("completionReadbackConfirmed");

    const recoveryReplay = between(rpc, "async function replayRecovery", "async function show");
    expect(recoveryReplay).toContain(
      '"requires stage=recovery_check (current stage: completed)"',
    );
    expect(recoveryReplay).toContain('blockedBy: "completed_stage_gate"');
  });

  it("constructs the released report from allowlisted fields and rejects sensitive material", async () => {
    const report = await source("scripts/final-proof-report.mjs");

    expect(report).toContain("export function assertSanitizedReport");
    expect(report).toContain("FORBIDDEN_KEY");
    expect(report).toContain("WINDOWS_ABSOLUTE_PATH");
    expect(report).toContain("sanitized report contains an absolute path");
    expect(report).toContain("sanitized report contains forbidden key");
    expect(report).toContain("export function buildFastDemoReport");
    expect(report).toContain("export function buildKindSafetyReport");
    expect(report).toContain("export function buildFullDemoReport");

    const kindReport = between(report, "export function buildKindSafetyReport", "async function read(path)");
    expect(kindReport).toContain("return assertSanitizedReport({");
    expect(kindReport).toContain("unauthorizedStateCreated: false");
    expect(kindReport).toContain("dispatchCount: rollback.mutationDispatchCount");
    expect(kindReport).toContain("scaleToZeroDecision: negative.decision");
    expect(kindReport).toContain("completedStateSurvivedRestart");
    expect(kindReport).toContain("localImageTagsDeleted");
    expect(kindReport).not.toContain("sessionKey");
    expect(kindReport).not.toContain("kubeconfigPath");
    expect(kindReport).not.toContain("rawWebhook");
  });
});
