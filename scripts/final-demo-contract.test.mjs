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

describe("final demo source contract", () => {
  it("exposes one fast command and one full command with no paid or cluster work in fast mode", async () => {
    const [packageText, fast, full] = await Promise.all([
      source("package.json"),
      source("scripts/run-final-fast-demo.sh"),
      source("scripts/run-final-demo.sh"),
    ]);
    const packageJson = JSON.parse(packageText);

    expect(packageJson.scripts["demo:fast"]).toBe(
      "bash scripts/run-final-fast-demo.sh",
    );
    expect(packageJson.scripts.demo).toBe("bash scripts/run-final-demo.sh");

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

    expectInOrder(full, [
      "run-final-fast-demo.sh",
      "GUARDIAN_FINAL_DEMO=1",
      "run-kind-prometheus-recovery-proof.sh",
      "final-proof-report.mjs full",
    ]);
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
    expect(runner).toContain('`${ports.join(" ")}\\n`');
    expect(runner).toContain("kind safety proof failed during ${CURRENT_PHASE}");
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
