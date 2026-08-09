import { readFile, writeFile } from "node:fs/promises";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import {
  GatewayIncidentClient,
  incidentSessionKey,
} from "../dist/alertmanager/http-bridge/gateway-incident-client.js";
import {
  createKubernetesDeploymentClient,
  resolveKubernetesToolConfig,
} from "../dist/kubernetes/config.js";
import {
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
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
import {
  createIncidentOccurrenceId,
  readIncidentStateV3,
} from "../dist/state/incident-state.js";
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
  'max(payment_success_rate{service="payments",environment="proof"}) or vector(0)';
const FINAL_DEMO = process.env.GUARDIAN_FINAL_DEMO === "1";
const BRIDGE_URL = process.env.ALERTMANAGER_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.ALERTMANAGER_BRIDGE_TOKEN;
const AMBIGUOUS_FILE =
  process.env.OPENCLAW_KIND_RECOVERY_AMBIGUOUS_FILE ??
  ".openclaw-proof/kind-prometheus-ambiguous.json";

const command = process.argv[2];
const COMMANDS = [
  "prepare",
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

function assertPolicyBlock(invocation, expectedReason, label) {
  assert(
    invocation?.ok === false &&
      invocation.error?.code === "forbidden" &&
      typeof invocation.error.message === "string" &&
      invocation.error.message.includes(expectedReason),
    `${label} was not blocked by the expected policy gate: ${JSON.stringify(invocation)}`,
  );
}

function deploymentMutationFingerprint(deployment) {
  const template = deployment.spec?.template;
  assert(template, "Deployment PodTemplate is missing");
  const annotations = deployment.metadata?.annotations ?? {};
  return {
    generation: deployment.metadata?.generation ?? null,
    templateSha256: templateSha256(template),
    rollbackAudit: {
      keyHash: annotations[ROLLBACK_KEY_HASH_ANNOTATION] ?? null,
      fromRevision: annotations[ROLLBACK_FROM_REVISION_ANNOTATION] ?? null,
      toRevision: annotations[ROLLBACK_TO_REVISION_ANNOTATION] ?? null,
      templateSha256:
        annotations[ROLLBACK_TEMPLATE_HASH_ANNOTATION] ?? null,
    },
  };
}

function mutationFingerprintMatches(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireFinalBridge() {
  if (!FINAL_DEMO || !BRIDGE_URL || !BRIDGE_TOKEN) {
    throw new Error(
      "final HTTP proof requires GUARDIAN_FINAL_DEMO=1, ALERTMANAGER_BRIDGE_URL, and ALERTMANAGER_BRIDGE_TOKEN",
    );
  }
}

async function readResume() {
  return JSON.parse(await readFile(RESUME_FILE, "utf8"));
}

async function writeResume(value) {
  await writeFile(RESUME_FILE, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readAmbiguous() {
  return JSON.parse(await readFile(AMBIGUOUS_FILE, "utf8"));
}

async function writeAmbiguous(value) {
  await writeFile(
    AMBIGUOUS_FILE,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
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
  clientVersion: "2026.6.34",
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

async function requestLobsterApproval(sessionKey, occurrenceId, approve = true) {
  const run = await client.request(
    "tools.invoke",
    buildLobsterApprovalRunRequest(sessionKey, occurrenceId),
  );
  const details = run.output?.details;
  const resumeToken = details?.requiresApproval?.resumeToken;
  assert(run.ok === true && details?.status === "needs_approval" && resumeToken,
    `Lobster did not pause for approval: ${JSON.stringify(run)}`);
  const resumeRequest = buildLobsterApprovalResumeRequest(
    sessionKey,
    resumeToken,
  );
  resumeRequest.args.approve = approve;
  const resumed = await client.request("tools.invoke", resumeRequest);
  const expectedStatus = approve ? "ok" : "cancelled";
  assert(
    resumed.ok === true && resumed.output?.details?.status === expectedStatus,
    `Lobster approval did not resume as ${expectedStatus}: ${JSON.stringify(resumed)}`,
  );
  return { approved: approve, workflowStatus: expectedStatus };
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

async function invokeTool(sessionKey, name, args) {
  const invocation = await client.request("tools.invoke", {
    name,
    args,
    sessionKey,
  });
  assert(
    invocation.ok === true,
    `${name} failed: ${JSON.stringify(invocation)}`,
  );
  return invocation.output?.details;
}

async function queryPrometheus(sessionKey = SESSION_KEY) {
  const invocation = await client.request("tools.invoke", {
    name: "guardian_query_prometheus",
    args: { query: PROMETHEUS_QUERY },
    sessionKey,
  });
  assert(invocation.ok === true, `Prometheus tool failed: ${JSON.stringify(invocation)}`);
  return invocation.output?.details;
}

function webhookPayload({ fingerprint, startsAt, status = "firing" }) {
  const resolved = status === "resolved";
  return {
    version: "4",
    groupKey: '{}:{alertname="PaymentSuccessRateLow"}',
    truncatedAlerts: 0,
    status,
    receiver: "guardian-final-proof",
    groupLabels: { alertname: "PaymentSuccessRateLow" },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://alertmanager.invalid",
    alerts: [
      {
        status,
        labels: {
          alertname: "PaymentSuccessRateLow",
          namespace: NAMESPACE,
          deployment: DEPLOYMENT,
        },
        annotations: { summary: "Payments are unhealthy." },
        startsAt,
        endsAt: resolved ? now() : new Date(Date.now() + 300_000).toISOString(),
        generatorURL: "http://prometheus.invalid/graph",
        fingerprint,
      },
    ],
  };
}

async function postWebhook(payload, { authorized = true } = {}) {
  requireFinalBridge();
  const response = await fetch(`${BRIDGE_URL}/v1/alertmanager/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { authorization: `Bearer ${BRIDGE_TOKEN}` } : {}),
    },
    body: JSON.stringify(payload),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

async function createHttpIncident(prefix, { proveIngress = false } = {}) {
  requireFinalBridge();
  const startsAt = new Date(Date.now() - 60_000).toISOString();
  const fingerprint = `kind-final-${prefix}`;
  const payload = webhookPayload({ fingerprint, startsAt });
  const occurrenceId = createIncidentOccurrenceId(fingerprint, startsAt);
  const sessionKey = incidentSessionKey(occurrenceId);

  if (proveIngress) {
    const unauthorized = await postWebhook(payload, { authorized: false });
    assert(
      unauthorized.status === 401,
      `missing bridge token expected 401, got ${unauthorized.status}`,
    );
    assert(
      (await incidentStore.describeIncidentState(sessionKey)) === undefined,
      "unauthorized webhook created incident state",
    );
  }

  const created = await postWebhook(payload);
  assert(
    created.status === 200 && created.body?.results?.[0]?.disposition === "created",
    `authorized webhook did not create an incident: ${JSON.stringify(created)}`,
  );
  assert(
    created.body.results[0].occurrenceId === occurrenceId,
    "bridge occurrenceId did not match canonical occurrence identity",
  );

  if (proveIngress) {
    const duplicate = await postWebhook(payload);
    assert(
      duplicate.status === 200 &&
        duplicate.body?.results?.[0]?.disposition === "duplicate",
      `replayed webhook was not deduplicated: ${JSON.stringify(duplicate)}`,
    );
  }

  const state = await readState(sessionKey);
  assert(
    state.evidence.length === 0,
    "Alertmanager webhook was incorrectly treated as metric evidence",
  );
  return { sessionKey, state, fingerprint, startsAt };
}

async function collectEvidenceAndPropose(sessionKey, initialState) {
  let sample;
  const deadline = Date.now() + 20_000;
  do {
    sample = await queryPrometheus(sessionKey);
    if (Date.parse(sample?.observedAt) >= Date.parse(initialState.updatedAt)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  assert(
    sample?.currentValue === 0.7,
    `expected degraded metric 0.7, got ${JSON.stringify(sample)}`,
  );
  assert(
    Date.parse(sample.observedAt) >= Date.parse(initialState.updatedAt),
    "Prometheus evidence timestamp did not catch up to HTTP ingress",
  );

  const metric = await invokeTool(
    sessionKey,
    "guardian_inspect_metric_snapshot",
    {
      alertId: initialState.alertId,
      metric: "payment_success_rate",
      currentValue: sample.currentValue,
      baselineValue: 1,
      source: `prometheus:${sample.query}`,
    },
  );
  assert(
    metric?.classification === "critical",
    `metric was not critical: ${JSON.stringify(metric)}`,
  );
  let state = recordMetricEvidence(initialState, metric, sample.observedAt);
  await incidentStore.persistIncidentState(sessionKey, state);

  const proposal = await invokeTool(
    sessionKey,
    "guardian_propose_remediation",
    {
      alertId: metric.alertId,
      metric: metric.metric,
      classification: metric.classification,
    },
  );
  state = recordRemediationProposal(state, proposal, now());
  await incidentStore.persistIncidentState(sessionKey, state);
  assert(
    state.stage === "approval" && state.evidenceValidation.status === "passed",
    `Gateway Tool evidence did not reach approval: ${state.stage}`,
  );
  return { state, sample, metric, proposal };
}

function buildIdempotencyKey(state, target, suffix = "attempt-1") {
  return (
    `guardian:k8s-rollback:v1:${state.occurrenceId}:${target.deploymentUid}:` +
    `${target.fromRevision}:${target.toRevision}:${suffix}`
  );
}

async function authorizeIncident({
  sessionKey,
  state,
  target,
  approve,
  suffix,
}) {
  const idempotencyKey = buildIdempotencyKey(state, target, suffix);
  const authorized = await authorizeRemediationWithLobster({
    sessionKey,
    approvalState: state,
    idempotencyKey,
    target,
    decidedAt: now(),
    startedAt: now(),
    writer: incidentStore,
    requestApproval: () =>
      requestLobsterApproval(sessionKey, state.occurrenceId, approve),
  });
  return { idempotencyKey, authorized };
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
    requestApproval: () =>
      requestLobsterApproval(SESSION_KEY, state.occurrenceId),
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

async function prepareHttp(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({
    kubernetes: rawKubernetesConfig,
  });
  const target = await discoverTarget(kubernetesConfig);
  const ingress = await createHttpIncident("positive", { proveIngress: true });
  const evidence = await collectEvidenceAndPropose(
    ingress.sessionKey,
    ingress.state,
  );
  const { idempotencyKey, authorized } = await authorizeIncident({
    sessionKey: ingress.sessionKey,
    state: evidence.state,
    target,
    approve: true,
    suffix: "positive-attempt-1",
  });
  assert(
    authorized.decision === "started",
    `HTTP-ingressed rollback was not authorized: ${authorized.decision}`,
  );
  await writeResume({
    sessionKey: ingress.sessionKey,
    idempotencyKey,
    target,
    ingress: {
      fingerprint: ingress.fingerprint,
      startsAt: ingress.startsAt,
    },
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "prepare-http",
      unauthorizedStatus: 401,
      authorizedDisposition: "created",
      replayDisposition: "duplicate",
      webhookEvidenceCount: ingress.state.evidence.length,
      degradedMetric: evidence.sample.currentValue,
      classification: evidence.metric.classification,
      evidenceTools: [
        "guardian_query_prometheus",
        "guardian_inspect_metric_snapshot",
        "guardian_propose_remediation",
      ],
      approvalEntry: "authorizeRemediationWithLobster",
      workflowStatus: authorized.workflowStatus,
      stage: authorized.state.stage,
      attemptStatus: authorized.state.remediationAttempts.at(-1)?.status,
    })}\n`,
  );
}

async function deniedApproval(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({
    kubernetes: rawKubernetesConfig,
  });
  const target = await discoverTarget(kubernetesConfig);
  const before = deploymentMutationFingerprint(
    await readDeployment(kubernetesConfig),
  );
  const ingress = await createHttpIncident("denied");
  const evidence = await collectEvidenceAndPropose(
    ingress.sessionKey,
    ingress.state,
  );
  const { idempotencyKey, authorized } = await authorizeIncident({
    sessionKey: ingress.sessionKey,
    state: evidence.state,
    target,
    approve: false,
    suffix: "denied-attempt-1",
  });
  assert(
    authorized.decision === "denied" &&
      authorized.workflowStatus === "cancelled" &&
      authorized.state.stage === "blocked" &&
      authorized.state.approvalStatus === "denied" &&
      authorized.state.remediationAttempts.length === 0,
    `Lobster denial was not durably blocked: ${JSON.stringify(authorized)}`,
  );
  const invocation = await client.request("tools.invoke", {
    name: "guardian_rollback_deployment",
    args: { idempotencyKey, target },
    sessionKey: ingress.sessionKey,
  });
  assertPolicyBlock(
    invocation,
    "requires an approved incident",
    "denied incident rollback",
  );
  const after = deploymentMutationFingerprint(
    await readDeployment(kubernetesConfig),
  );
  assert(
    mutationFingerprintMatches(before, after),
    "denied approval changed the Deployment",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "denied-approval",
      workflowStatus: authorized.workflowStatus,
      approvalStatus: authorized.state.approvalStatus,
      stage: authorized.state.stage,
      rollbackBlocked: true,
      blockedBy: "approval_gate",
      mutationDispatchCount: 0,
      generationUnchanged: true,
      mutationFingerprintUnchanged: true,
    })}\n`,
  );
}

async function prepareAmbiguous(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({
    kubernetes: rawKubernetesConfig,
  });
  const target = await discoverTarget(kubernetesConfig);
  const before = deploymentMutationFingerprint(
    await readDeployment(kubernetesConfig),
  );
  const ingress = await createHttpIncident("ambiguous");
  const evidence = await collectEvidenceAndPropose(
    ingress.sessionKey,
    ingress.state,
  );
  const { idempotencyKey, authorized } = await authorizeIncident({
    sessionKey: ingress.sessionKey,
    state: evidence.state,
    target,
    approve: true,
    suffix: "ambiguous-attempt-1",
  });
  assert(
    authorized.decision === "started" &&
      authorized.state.remediationAttempts.at(-1)?.status === "running",
    "ambiguous fixture did not persist a running attempt",
  );
  await writeAmbiguous({
    sessionKey: ingress.sessionKey,
    idempotencyKey,
    target,
    mutationFingerprint: before,
  });
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "prepare-ambiguous",
      attemptStatus: "running",
      mutationDispatchCount: 0,
    })}\n`,
  );
}

async function reconcileAmbiguous(rawKubernetesConfig) {
  const record = await readAmbiguous();
  const kubernetesConfig = resolveKubernetesToolConfig({
    kubernetes: rawKubernetesConfig,
  });
  const state = await readState(record.sessionKey);
  const result = await reconcileIncidentOnRestart({
    state,
    reconciler: new KubernetesDeploymentRollbackReconciler(kubernetesConfig),
    reconciledAt: now(),
  });
  assert(
    result.decision === "manual_review" &&
      result.externalOutcome === "unknown" &&
      result.state.stage === "blocked",
    `unmutated attempt did not fail closed to manual review: ${JSON.stringify(result)}`,
  );
  await incidentStore.persistIncidentState(record.sessionKey, result.state);
  const after = deploymentMutationFingerprint(
    await readDeployment(kubernetesConfig),
  );
  assert(
    mutationFingerprintMatches(record.mutationFingerprint, after),
    "ambiguous reconciliation changed the Deployment",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "reconcile-ambiguous",
      decision: result.decision,
      externalOutcome: result.externalOutcome,
      stage: result.state.stage,
      mutationDispatchCount: 0,
      generationUnchanged: true,
      mutationFingerprintUnchanged: true,
    })}\n`,
  );
}

async function offTarget(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({
    kubernetes: rawKubernetesConfig,
  });
  const allowedTarget = await discoverTarget(kubernetesConfig);
  const deniedTarget = {
    ...allowedTarget,
    namespace: "default",
    deployment: "not-allowlisted",
  };
  const before = deploymentMutationFingerprint(
    await readDeployment(kubernetesConfig),
  );
  const ingress = await createHttpIncident("off-target");
  const evidence = await collectEvidenceAndPropose(
    ingress.sessionKey,
    ingress.state,
  );
  const { idempotencyKey, authorized } = await authorizeIncident({
    sessionKey: ingress.sessionKey,
    state: evidence.state,
    target: deniedTarget,
    approve: true,
    suffix: "off-target-attempt-1",
  });
  assert(authorized.decision === "started", "off-target fixture was not approved");
  const invocation = await client.request("tools.invoke", {
    name: "guardian_rollback_deployment",
    args: { idempotencyKey, target: deniedTarget },
    sessionKey: ingress.sessionKey,
  });
  assertPolicyBlock(
    invocation,
    "outside the administrator allowlist",
    "off-target rollback",
  );
  const after = deploymentMutationFingerprint(
    await readDeployment(kubernetesConfig),
  );
  assert(
    mutationFingerprintMatches(before, after),
    "off-target call changed the allowlisted Deployment",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "off-target",
      blocked: true,
      blockedBy: "allowlist_gate",
      mutationDispatchCount: 0,
      generationUnchanged: true,
      mutationFingerprintUnchanged: true,
    })}\n`,
  );
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
  const details = invocation.output?.details;
  assert(invocation.ok === true && details?.decision === "rolled_back",
    `rollback failed: ${JSON.stringify(invocation)}`);
  const after = await readDeployment(config);
  const generationBefore = before.metadata?.generation;
  const generationAfter = after.metadata?.generation;
  const resourceVersionBefore = before.metadata?.resourceVersion;
  const resourceVersionAfter = after.metadata?.resourceVersion;
  assert(
    Number.isInteger(generationBefore) &&
      generationAfter === generationBefore + 1 &&
      typeof resourceVersionBefore === "string" &&
      typeof resourceVersionAfter === "string" &&
      resourceVersionAfter !== resourceVersionBefore &&
      details.patched === true &&
      details.templateSha256 === record.target.toTemplateSha256 &&
      templateSha256(after.spec.template) === record.target.toTemplateSha256,
    "rolled_back decision did not produce the expected Deployment mutation",
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "rollback",
    decision: details.decision,
    patched: details.patched,
    mutationDispatchCount: 1,
    generationChanged: true,
    resourceVersionChanged: true,
    templateMatchesTarget: true,
  })}\n`);
}

async function replayRollback(rawKubernetesConfig) {
  const record = await readResume();
  const config = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const before = deploymentMutationFingerprint(await readDeployment(config));
  const invocation = await invokeRollback(record);
  const details = invocation.output?.details;
  assert(
    invocation.ok === true &&
      details?.decision === "duplicate" &&
      details.patched === false,
    `rollback replay was not a duplicate: ${JSON.stringify(invocation)}`);
  const after = deploymentMutationFingerprint(await readDeployment(config));
  assert(
    mutationFingerprintMatches(before, after),
    "rollback replay changed the Deployment mutation fingerprint",
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "replay-rollback",
    decision: "duplicate",
    patched: false,
    generationUnchanged: true,
    mutationFingerprintUnchanged: true,
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

async function resolvedNotRecovered() {
  const record = await readResume();
  assert(record.ingress, "final ingress metadata is missing from the resume record");
  const response = await postWebhook(
    webhookPayload({
      fingerprint: record.ingress.fingerprint,
      startsAt: record.ingress.startsAt,
      status: "resolved",
    }),
  );
  assert(
    response.status === 200 &&
      response.body?.results?.[0]?.disposition === "updated",
    `resolved webhook was not applied: ${JSON.stringify(response)}`,
  );
  const state = await readState(record.sessionKey);
  assert(state.alertStatus === "resolved", "resolved webhook did not update alertStatus");
  assert(
    state.stage === "recovery_check",
    `resolved webhook incorrectly changed recovery stage to ${state.stage}`,
  );
  assert(
    !state.evidence.some(
      (entry) => entry.source === "guardian_deployment_prometheus_recovery",
    ),
    "resolved webhook fabricated recovery evidence",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "resolved-not-recovered",
      alertStatus: state.alertStatus,
      incidentStage: state.stage,
      recoveryEvidencePresent: false,
      incidentCompleted: false,
    })}\n`,
  );
}

async function verifyNegativeRecovery() {
  const record = await readResume();
  const state = await readState(record.sessionKey);
  const attempt = state.remediationAttempts.at(-1);
  assert(
    attempt?.idempotencyKey === record.idempotencyKey &&
      attempt.status === "succeeded" &&
      attempt.finishedAt,
    "negative recovery check requires the latest succeeded attempt",
  );
  const details = await invokeTool(
    record.sessionKey,
    "guardian_verify_deployment_recovery",
    {
      idempotencyKey: record.idempotencyKey,
      target: record.target,
      notBefore: attempt.finishedAt,
    },
  );
  assert(
    details?.decision === "not_recovered" &&
      details.deployment?.issues?.includes("desired_replicas_not_positive"),
    `scale-to-zero did not fail dual recovery: ${JSON.stringify(details)}`,
  );
  const unchanged = await readState(record.sessionKey);
  assert(
    unchanged.stage === "recovery_check",
    "read-only negative recovery observation completed or advanced the incident",
  );
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "verify-negative-recovery",
      decision: details.decision,
      deploymentHealthy: details.deployment.healthy,
      deploymentIssues: details.deployment.issues,
      incidentStage: unchanged.stage,
      incidentCompleted: false,
      checkedAt: details.checkedAt,
    })}\n`,
  );
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

  // persistDeploymentRecoveryVerification re-reads the current IncidentState
  // from `store` itself immediately before writing, so it always binds
  // against the latest state rather than the snapshot read above at the
  // start of this (potentially minutes-long) polling loop.
  const completed = await persistDeploymentRecoveryVerification({
    sessionKey: record.sessionKey,
    idempotencyKey: record.idempotencyKey,
    target: record.target,
    result: details,
    store: incidentStore,
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
    completionReadbackConfirmed: completed.stage === "completed",
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
  assertPolicyBlock(
    invocation,
    "requires stage=recovery_check (current stage: completed)",
    "completed incident recovery replay",
  );
  process.stdout.write(`${JSON.stringify({
    ok: true,
    command: "replay-recovery",
    blocked: true,
    blockedBy: "completed_stage_gate",
    incidentStage: state.stage,
  })}\n`);
}

async function show() {
  const record = await readResume().catch(() => undefined);
  const state = await readState(record?.sessionKey ?? SESSION_KEY);
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
  else if (command === "prepare-http") await prepareHttp(rawKubernetesConfig);
  else if (command === "denied-approval") await deniedApproval(rawKubernetesConfig);
  else if (command === "prepare-ambiguous") await prepareAmbiguous(rawKubernetesConfig);
  else if (command === "reconcile-ambiguous") await reconcileAmbiguous(rawKubernetesConfig);
  else if (command === "off-target") await offTarget(rawKubernetesConfig);
  else if (command === "rollback") await rollback(rawKubernetesConfig);
  else if (command === "replay-rollback") await replayRollback(rawKubernetesConfig);
  else if (command === "reconcile") await reconcile(rawKubernetesConfig);
  else if (command === "resolved-not-recovered") await resolvedNotRecovered();
  else if (command === "verify-negative-recovery") await verifyNegativeRecovery();
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
