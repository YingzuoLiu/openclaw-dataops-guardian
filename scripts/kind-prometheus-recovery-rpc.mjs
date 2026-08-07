import { readFile, writeFile } from "node:fs/promises";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import { GatewayIncidentClient } from "../dist/alertmanager/http-bridge/gateway-incident-client.js";
import {
  createKubernetesDeploymentClient,
  resolveKubernetesToolConfig,
} from "../dist/kubernetes/config.js";
import {
  templateSha256,
} from "../dist/kubernetes/deployment-rollback.js";
import { KubernetesDeploymentRollbackReconciler } from "../dist/kubernetes/deployment-rollback-reconciler.js";
import { authorizeRemediationWithLobster } from "../dist/runtime/lobster-remediation-entry.js";
import {
  buildLobsterApprovalResumeRequest,
  buildLobsterApprovalRunRequest,
} from "../dist/runtime/lobster-approval-payload.js";
import { persistDeploymentRecoveryVerification } from "../dist/runtime/recovery-verification-entry.js";
import { reduceAlertDelivery } from "../dist/state/incident-reducer.js";
import { readIncidentStateV3 } from "../dist/state/incident-state.js";
import {
  recordMetricEvidence,
  recordRemediationProposal,
} from "../dist/state/incident-workflow.js";
import { reconcileIncidentOnRestart } from "../dist/state/restart-reconciliation.js";
import { inspectMetricSnapshot } from "../dist/tools/inspect-metric-snapshot.js";
import { proposeRemediation } from "../dist/tools/propose-remediation.js";

const SESSION_KEY = "agent:main:dataops-guardian-kind-prometheus-recovery";
const RESUME_FILE =
  process.env.OPENCLAW_KIND_RECOVERY_RESUME_FILE ??
  ".openclaw-proof/kind-prometheus-recovery-resume.json";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT ?? "19188";
const NAMESPACE = process.env.GUARDIAN_STEP4_NAMESPACE ?? "guardian-step4";
const DEPLOYMENT = process.env.GUARDIAN_STEP4_DEPLOYMENT ?? "payments-step4";
const PROMETHEUS_QUERY =
  process.env.GUARDIAN_STEP4_PROMETHEUS_QUERY ??
  'payment_success_rate{service="payments",environment="proof"}';

const command = process.argv[2];
const COMMANDS = [
  "prepare",
  "rollback",
  "replay-rollback",
  "reconcile",
  "verify-recovery",
  "replay-recovery",
  "show",
];
if (!COMMANDS.includes(command)) {
  throw new Error(`usage: node kind-prometheus-recovery-rpc.mjs <${COMMANDS.join("|")}>`);
}
if (!GATEWAY_TOKEN) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

function now() {
  return new Date().toISOString();
}

function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

async function readResume() {
  return JSON.parse(await readFile(RESUME_FILE, "utf8"));
}

async function writeResume(value) {
  await writeFile(RESUME_FILE, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const client = new GatewayClient({
  url: `ws://127.0.0.1:${GATEWAY_PORT}`,
  token: GATEWAY_TOKEN,
  clientName: "gateway-client",
  clientDisplayName: "dataops-guardian-kind-prometheus-recovery",
  clientVersion: "2026.6.9",
  platform: process.platform,
  mode: "backend",
  requestTimeoutMs: 20_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});
const incidentStore = new GatewayIncidentClient({
  url: `ws://127.0.0.1:${GATEWAY_PORT}`,
  token: GATEWAY_TOKEN,
  clientDisplayName: "dataops-guardian-kind-prometheus-recovery-state",
  requestTimeoutMs: 20_000,
  connectTimeoutMs: 15_000,
});

async function readState(sessionKey = SESSION_KEY) {
  const raw = await incidentStore.describeIncidentState(sessionKey);
  assert(raw, `incident state is missing for ${sessionKey}`);
  const decoded = readIncidentStateV3(raw);
  assert(decoded.ok, `incident state is invalid: ${decoded.error}`);
  return decoded.state;
}

async function requestLobsterApproval(occurrenceId) {
  const run = await client.request(
    "tools.invoke",
    buildLobsterApprovalRunRequest(SESSION_KEY, occurrenceId),
  );
  const details = run.output?.details;
  const resumeToken = details?.requiresApproval?.resumeToken;
  assert(run.ok === true && details?.status === "needs_approval" && resumeToken,
    `Lobster did not pause for approval: ${JSON.stringify(run)}`);
  const resumed = await client.request(
    "tools.invoke",
    buildLobsterApprovalResumeRequest(SESSION_KEY, resumeToken),
  );
  assert(resumed.ok === true && resumed.output?.details?.status === "ok",
    `Lobster approval did not resume: ${JSON.stringify(resumed)}`);
  return { approved: true, workflowStatus: "ok" };
}

async function readDeployment(kubernetesConfig) {
  const { api } = await createKubernetesDeploymentClient(kubernetesConfig);
  return api.readNamespacedDeployment({ name: DEPLOYMENT, namespace: NAMESPACE });
}

async function discoverTarget(kubernetesConfig) {
  const { api } = await createKubernetesDeploymentClient(kubernetesConfig);
  const deployment = await api.readNamespacedDeployment({
    name: DEPLOYMENT,
    namespace: NAMESPACE,
  });
  const uid = deployment.metadata?.uid;
  const fromRevision = Number.parseInt(
    deployment.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "",
    10,
  );
  assert(uid, "Deployment UID is missing");
  assert(Number.isInteger(fromRevision) && fromRevision > 1, "Deployment has no prior revision");
  const replicaSets = await api.listNamespacedReplicaSet({ namespace: NAMESPACE });
  const toRevision = fromRevision - 1;
  const historical = replicaSets.items.find(
    (replicaSet) =>
      replicaSet.metadata?.annotations?.["deployment.kubernetes.io/revision"] === String(toRevision) &&
      (replicaSet.metadata?.ownerReferences ?? []).some(
        (owner) => owner.controller === true && owner.kind === "Deployment" && owner.uid === uid,
      ),
  );
  assert(historical?.spec?.template, `historical ReplicaSet revision ${toRevision} is missing`);
  return {
    type: "kubernetes_deployment_rollback_v1",
    clusterId: kubernetesConfig.clusterId,
    namespace: NAMESPACE,
    deployment: DEPLOYMENT,
    deploymentUid: uid,
    fromRevision,
    toRevision,
    fromTemplateSha256: templateSha256(deployment.spec.template),
    toTemplateSha256: templateSha256(historical.spec.template),
  };
}

async function queryPrometheus() {
  const invocation = await client.request("tools.invoke", {
    name: "guardian_query_prometheus",
    args: { query: PROMETHEUS_QUERY },
    sessionKey: SESSION_KEY,
  });
  assert(invocation.ok === true, `Prometheus tool failed: ${JSON.stringify(invocation)}`);
  return invocation.output?.details;
}

async function prepare(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const target = await discoverTarget(kubernetesConfig);
  const sample = await queryPrometheus();
  assert(sample?.currentValue === 0.7, `expected degraded metric 0.7, got ${JSON.stringify(sample)}`);
  const startsAt = sample.observedAt;
  const created = reduceAlertDelivery(undefined, {
    alertId: "kind-prometheus-recovery-proof",
    fingerprint: "kind-prometheus-recovery-fingerprint",
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "delivery-1",
  });
  assert(created.state, "firing delivery did not create an incident");

  const metric = inspectMetricSnapshot({
    alertId: "kind-prometheus-recovery-proof",
    metric: "payment_success_rate",
    currentValue: sample.currentValue,
    baselineValue: 1,
    source: `prometheus:${PROMETHEUS_QUERY}`,
  });
  assert(metric.classification === "critical", `metric was not critical: ${metric.classification}`);
  const proposal = proposeRemediation({
    alertId: metric.alertId,
    metric: metric.metric,
    classification: metric.classification,
  });
  let state = recordMetricEvidence(created.state, metric, sample.observedAt);
  state = recordRemediationProposal(state, proposal, now());
  assert(state.stage === "approval", `evidence did not reach approval: ${state.stage}`);

  const idempotencyKey =
    `guardian:k8s-rollback:v1:${state.occurrenceId}:${target.deploymentUid}:` +
    `${target.fromRevision}:${target.toRevision}:attempt-1`;
  const authorized = await authorizeRemediationWithLobster({
    sessionKey: SESSION_KEY,
    approvalState: state,
    idempotencyKey,
    target,
    decidedAt: now(),
    startedAt: now(),
    writer: incidentStore,
    requestApproval: () => requestLobsterApproval(state.occurrenceId),
  });
  assert(authorized.decision === "started", `rollback was not authorized: ${authorized.decision}`);
  await writeResume({ sessionKey: SESSION_KEY, idempotencyKey, target });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "prepare",
    degradedMetric: sample.currentValue,
    classification: metric.classification,
    approvalEntry: "authorizeRemediationWithLobster",
    workflowStatus: authorized.workflowStatus,
    stage: authorized.state.stage,
    attemptStatus: authorized.state.remediationAttempts.at(-1)?.status,
  })}\n`);
}

async function invokeRollback(record) {
  return client.request("tools.invoke", {
    name: "guardian_rollback_deployment",
    args: { idempotencyKey: record.idempotencyKey, target: record.target },
    sessionKey: record.sessionKey,
  });
}

async function rollback(rawKubernetesConfig) {
  const record = await readResume();
  const config = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const before = await readDeployment(config);
  const invocation = await invokeRollback(record);
  assert(invocation.ok === true && invocation.output?.details?.decision === "rolled_back",
    `rollback failed: ${JSON.stringify(invocation)}`);
  const after = await readDeployment(config);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "rollback",
    decision: invocation.output.details.decision,
    generationBefore: before.metadata?.generation ?? null,
    generationAfter: after.metadata?.generation ?? null,
    resourceVersionBefore: before.metadata?.resourceVersion ?? null,
    resourceVersionAfter: after.metadata?.resourceVersion ?? null,
  })}\n`);
}

async function replayRollback(rawKubernetesConfig) {
  const record = await readResume();
  const config = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const before = await readDeployment(config);
  const invocation = await invokeRollback(record);
  assert(invocation.ok === true && invocation.output?.details?.decision === "duplicate",
    `rollback replay was not a duplicate: ${JSON.stringify(invocation)}`);
  const after = await readDeployment(config);
  assert(before.metadata?.generation === after.metadata?.generation, "rollback replay changed generation");
  assert(before.metadata?.resourceVersion === after.metadata?.resourceVersion,
    "rollback replay changed resourceVersion");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "replay-rollback",
    decision: "duplicate",
    generationUnchanged: true,
    resourceVersionUnchanged: true,
  })}\n`);
}

async function reconcile(rawKubernetesConfig) {
  const record = await readResume();
  const config = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const state = await readState(record.sessionKey);
  const result = await reconcileIncidentOnRestart({
    state,
    reconciler: new KubernetesDeploymentRollbackReconciler(config),
    reconciledAt: now(),
  });
  assert(result.decision === "settled" && result.externalOutcome === "confirmed_succeeded",
    `restart reconciliation failed: ${JSON.stringify(result)}`);
  assert(result.state.stage === "recovery_check", `expected recovery_check, got ${result.state.stage}`);
  await incidentStore.persistIncidentState(record.sessionKey, result.state);
  const attempt = result.state.remediationAttempts.find(
    (candidate) => candidate.idempotencyKey === record.idempotencyKey,
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "reconcile",
    externalOutcome: result.externalOutcome,
    stage: result.state.stage,
    attemptStatus: attempt?.status,
    finishedAt: attempt?.finishedAt,
  })}\n`);
}

async function verifyRecovery() {
  const record = await readResume();
  const state = await readState(record.sessionKey);
  const attempt = state.remediationAttempts.find(
    (candidate) => candidate.idempotencyKey === record.idempotencyKey,
  );
  assert(attempt?.status === "succeeded" && attempt.finishedAt,
    "recovery requires a succeeded attempt with finishedAt");

  const deadline = Date.now() + 90_000;
  let details;
  do {
    const invocation = await client.request("tools.invoke", {
      name: "guardian_verify_deployment_recovery",
      args: {
        idempotencyKey: record.idempotencyKey,
        target: record.target,
        notBefore: attempt.finishedAt,
      },
      sessionKey: record.sessionKey,
    });
    assert(invocation.ok === true, `recovery tool failed: ${JSON.stringify(invocation)}`);
    details = invocation.output?.details;
    if (details?.decision === "recovered") break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } while (Date.now() < deadline);
  assert(details?.decision === "recovered", `recovery did not converge: ${JSON.stringify(details)}`);

  const completed = await persistDeploymentRecoveryVerification({
    sessionKey: record.sessionKey,
    state,
    idempotencyKey: record.idempotencyKey,
    target: record.target,
    result: details,
    writer: incidentStore,
  });
  assert(completed.stage === "completed", `expected completed, got ${completed.stage}`);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "verify-recovery",
    decision: details.decision,
    deploymentHealthy: details.deployment.healthy,
    desiredReplicas: details.deployment.desiredReplicas,
    availableReplicas: details.deployment.availableReplicas,
    prometheusHealthy: details.prometheus.healthy,
    prometheusValue: details.prometheus.currentValue,
    prometheusThreshold: details.prometheus.threshold,
    prometheusObservedAt: details.prometheus.observedAt,
    incidentStage: completed.stage,
    evidenceSource: completed.evidence.at(-1)?.source,
  })}\n`);
}

async function replayRecovery() {
  const record = await readResume();
  const state = await readState(record.sessionKey);
  const attempt = state.remediationAttempts.find(
    (candidate) => candidate.idempotencyKey === record.idempotencyKey,
  );
  const invocation = await client.request("tools.invoke", {
    name: "guardian_verify_deployment_recovery",
    args: {
      idempotencyKey: record.idempotencyKey,
      target: record.target,
      notBefore: attempt?.finishedAt,
    },
    sessionKey: record.sessionKey,
  });
  assert(invocation.ok !== true, "completed incident allowed a second recovery verification");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "replay-recovery",
    blocked: true,
    incidentStage: state.stage,
  })}\n`);
}

async function show() {
  const state = await readState();
  process.stdout.write(`${JSON.stringify({ ok: true, command: "show", state })}\n`);
}

async function run() {
  client.start();
  await Promise.all([
    Promise.race([
      ready,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("gateway connect timeout")), 15_000),
      ),
    ]),
    incidentStore.connect(),
  ]);
  const rawKubernetesConfig = JSON.parse(
    process.env.GUARDIAN_KUBERNETES_CONFIG_JSON ?? "{}",
  );
  if (command === "prepare") await prepare(rawKubernetesConfig);
  else if (command === "rollback") await rollback(rawKubernetesConfig);
  else if (command === "replay-rollback") await replayRollback(rawKubernetesConfig);
  else if (command === "reconcile") await reconcile(rawKubernetesConfig);
  else if (command === "verify-recovery") await verifyRecovery();
  else if (command === "replay-recovery") await replayRecovery();
  else await show();
}

try {
  await run();
} finally {
  await Promise.all([
    client.stopAndWait({ timeoutMs: 2_000 }),
    incidentStore.close(),
  ]);
}
