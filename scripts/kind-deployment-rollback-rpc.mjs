import { readFile, writeFile } from "node:fs/promises";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import { createIncidentOccurrenceId, readIncidentStateV3 } from "../dist/state/incident-state.js";
import { reduceAlertDelivery } from "../dist/state/incident-reducer.js";
import { reconcileIncidentOnRestart } from "../dist/state/restart-reconciliation.js";
import { GatewayIncidentClient } from "../dist/alertmanager/http-bridge/gateway-incident-client.js";
import { authorizeRemediationWithLobster } from "../dist/runtime/lobster-remediation-entry.js";
import {
  buildLobsterApprovalResumeRequest,
  buildLobsterApprovalRunRequest,
} from "../dist/runtime/lobster-approval-payload.js";
import {
  createKubernetesDeploymentClient,
  resolveKubernetesToolConfig,
} from "../dist/kubernetes/config.js";
import {
  hashIdempotencyKey,
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
  templateSha256,
} from "../dist/kubernetes/deployment-rollback.js";
import { KubernetesDeploymentRollbackReconciler } from "../dist/kubernetes/deployment-rollback-reconciler.js";

const SESSION_KEY = "agent:main:dataops-guardian-kind-deployment-rollback";
const SECOND_OCCURRENCE_SESSION_KEY =
  "agent:main:dataops-guardian-kind-deployment-rollback-second-occurrence";
const DENIED_SESSION_KEY = "agent:main:dataops-guardian-kind-deployment-rollback-denied";
const RESUME_FILE =
  process.env.OPENCLAW_KIND_ROLLBACK_RESUME_FILE ??
  ".openclaw-proof/kind-deployment-rollback-resume.json";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT ?? "19187";
const ALLOWED_NAMESPACE = process.env.GUARDIAN_STEP3_NAMESPACE ?? "guardian-step3";
const ALLOWED_DEPLOYMENT = process.env.GUARDIAN_STEP3_DEPLOYMENT ?? "payments-step3";
const DENIED_NAMESPACE = "default";
const DENIED_DEPLOYMENT = "not-allowlisted";

const command = process.argv[2];
const KNOWN_COMMANDS = [
  "prepare",
  "rollback",
  "replay",
  "denied-target",
  "post-restart-replay",
  "reconcile",
  "verify-blocked-after-resolution",
  "second-occurrence",
  "show",
];
if (!KNOWN_COMMANDS.includes(command)) {
  throw new Error(`usage: node kind-deployment-rollback-rpc.mjs <${KNOWN_COMMANDS.join("|")}>`);
}
if (!GATEWAY_TOKEN) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

function now() {
  return new Date().toISOString();
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

async function readResume() {
  return JSON.parse(await readFile(RESUME_FILE, "utf8"));
}

async function writeResume(record) {
  await writeFile(RESUME_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

// Non-UI backend-mode client (clientName: gateway-client, mode: backend,
// token auth): the same shape verified against a real Gateway in the
// runtime.getSessionEntry compatibility repro, and the reason
// gateway.controlUi.dangerouslyDisableDeviceAuth is no longer needed --
// that flag only exists for mode: "ui" connections, which this proof no
// longer uses.
const client = new GatewayClient({
  url: `ws://127.0.0.1:${GATEWAY_PORT}`,
  token: GATEWAY_TOKEN,
  clientName: "gateway-client",
  clientDisplayName: "dataops-guardian-kind-deployment-rollback",
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
  clientDisplayName: "dataops-guardian-kind-deployment-rollback-state-writer",
  requestTimeoutMs: 20_000,
  connectTimeoutMs: 15_000,
});

async function readState(sessionKey) {
  const value = await incidentStore.describeIncidentState(sessionKey);
  if (!value) {
    throw new Error(`incident state is missing for ${sessionKey}`);
  }
  const decoded = readIncidentStateV3(value);
  if (!decoded.ok) {
    throw new Error(`incident state decode failed for ${sessionKey}: ${decoded.error}`);
  }
  return decoded.state;
}

async function requestLobsterApproval(sessionKey, occurrenceId) {
  const run = await client.request(
    "tools.invoke",
    buildLobsterApprovalRunRequest(sessionKey, occurrenceId),
  );
  assert(run.ok === true, `Lobster approval workflow failed to start: ${JSON.stringify(run)}`);
  const details = run.output?.details;
  const resumeToken = details?.requiresApproval?.resumeToken;
  assert(
    details?.status === "needs_approval" && resumeToken,
    `Lobster did not pause for approval: ${JSON.stringify(details)}`,
  );

  const resumed = await client.request(
    "tools.invoke",
    buildLobsterApprovalResumeRequest(sessionKey, resumeToken),
  );
  assert(resumed.ok === true, `Lobster approval workflow failed to resume: ${JSON.stringify(resumed)}`);
  const resumedDetails = resumed.output?.details;
  assert(
    resumedDetails?.status === "ok",
    `Lobster approval workflow did not complete: ${JSON.stringify(resumedDetails)}`,
  );
  return { approved: true, workflowStatus: resumedDetails.status };
}

async function authorizeRollback(sessionKey, approvalState, idempotencyKey, target) {
  return authorizeRemediationWithLobster({
    sessionKey,
    approvalState,
    idempotencyKey,
    target,
    decidedAt: now(),
    startedAt: now(),
    writer: incidentStore,
    requestApproval: () => requestLobsterApproval(sessionKey, approvalState.occurrenceId),
  });
}

async function invokeRollbackTool(sessionKey, idempotencyKey, target) {
  return client.request("tools.invoke", {
    name: "guardian_rollback_deployment",
    args: { idempotencyKey, target },
    sessionKey,
  });
}

function buildIdempotencyKey(occurrenceId, target) {
  return `guardian:k8s-rollback:v1:${occurrenceId}:${target.deploymentUid}:${target.fromRevision}:${target.toRevision}:attempt-1`;
}

function deploymentImage(record) {
  return record.deployment.spec?.template?.spec?.containers?.[0]?.image ?? null;
}

/**
 * Reads the real kind Deployment and its owner-owned ReplicaSets to derive
 * the strict rollback target from live cluster facts -- nothing here is
 * fabricated. Assumes the deployment currently sits at the revision created
 * second (v2) with exactly one prior owner-owned revision (v1) available.
 */
async function discoverRollbackTarget(kubernetesConfig) {
  const { api } = await createKubernetesDeploymentClient(kubernetesConfig);
  const deployment = await api.readNamespacedDeployment({
    name: ALLOWED_DEPLOYMENT,
    namespace: ALLOWED_NAMESPACE,
  });
  const metadata = deployment.metadata;
  const fromRevision = Number.parseInt(
    metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "",
    10,
  );
  assert(metadata?.uid, "Deployment is missing uid");
  assert(Number.isInteger(fromRevision) && fromRevision > 1, "Deployment must have a prior revision");
  const fromTemplateSha256 = templateSha256(deployment.spec.template);

  const replicaSets = await api.listNamespacedReplicaSet({ namespace: ALLOWED_NAMESPACE });
  const toRevision = fromRevision - 1;
  const historical = (replicaSets.items ?? []).find(
    (rs) =>
      (rs.metadata?.ownerReferences ?? []).some(
        (owner) => owner.kind === "Deployment" && owner.uid === metadata.uid && owner.controller,
      ) && rs.metadata?.annotations?.["deployment.kubernetes.io/revision"] === String(toRevision),
  );
  assert(historical?.spec?.template, `no owner-owned ReplicaSet found for revision ${toRevision}`);
  const toTemplateSha256 = templateSha256(historical.spec.template);

  return {
    target: {
      type: "kubernetes_deployment_rollback_v1",
      clusterId: kubernetesConfig.clusterId,
      namespace: ALLOWED_NAMESPACE,
      deployment: ALLOWED_DEPLOYMENT,
      deploymentUid: metadata.uid,
      fromRevision,
      toRevision,
      fromTemplateSha256,
      toTemplateSha256,
    },
    resourceVersion: metadata.resourceVersion,
    generation: deployment.metadata?.generation ?? null,
  };
}

async function readDeploymentGeneration(kubernetesConfig) {
  const { api } = await createKubernetesDeploymentClient(kubernetesConfig);
  const deployment = await api.readNamespacedDeployment({
    name: ALLOWED_DEPLOYMENT,
    namespace: ALLOWED_NAMESPACE,
  });
  return {
    generation: deployment.metadata?.generation ?? null,
    resourceVersion: deployment.metadata?.resourceVersion ?? null,
    revision: deployment.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? null,
    deployment,
  };
}

/**
 * A Kubernetes rollback assigns the reactivated PodTemplate a *new* revision
 * number -- rolling back to historical revision N never makes the live
 * Deployment's own revision annotation become N again, it becomes
 * max(existing revisions) + 1. The controller also applies this
 * asynchronously, so this polls until a revision beyond fromRevision appears
 * with the expected live PodTemplate digest, rather than asserting equality
 * with toRevision.
 */
async function waitForDeploymentConvergence(
  kubernetesConfig,
  { fromRevision, toTemplateSha256 },
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await readDeploymentGeneration(kubernetesConfig);
    const revisionNumber = Number.parseInt(last.revision ?? "", 10);
    if (
      Number.isInteger(revisionNumber) &&
      revisionNumber > fromRevision &&
      last.deployment.spec?.template &&
      templateSha256(last.deployment.spec.template) === toTemplateSha256
    ) {
      return last;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Deployment did not converge to a new revision beyond ${fromRevision} with the expected PodTemplate within ${timeoutMs}ms (last observed revision=${last?.revision})`,
  );
}

async function prepare(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const { target } = await discoverRollbackTarget(kubernetesConfig);

  const startsAt = now();
  const created = reduceAlertDelivery(undefined, {
    alertId: "kind-deployment-rollback-proof",
    fingerprint: "kind-deployment-rollback-fingerprint",
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "delivery-1",
  });
  assert(created.state, "synthetic firing delivery did not create an incident");
  let state = created.state;

  state = {
    ...state,
    stage: "approval",
    proposedAction: "kubernetes_deployment_rollback",
    approvalStatus: "pending",
    evidenceValidation: { status: "passed", checkedAt: startsAt, issues: [] },
    updatedAt: startsAt,
  };

  const idempotencyKey = buildIdempotencyKey(state.occurrenceId, target);
  const authorized = await authorizeRollback(SESSION_KEY, state, idempotencyKey, target);
  assert(authorized.decision === "started", `remediation was not authorized: ${authorized.decision}`);

  await writeResume({
    sessionKey: SESSION_KEY,
    idempotencyKey,
    target,
    occurrenceId: state.occurrenceId,
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "prepare",
      idempotencyKey,
      target,
      approvalEntry: "authorizeRemediationWithLobster",
      workflowStatus: authorized.workflowStatus,
      persistedStage: authorized.state.stage,
      persistedApprovalStatus: authorized.state.approvalStatus,
      persistedAttemptStatus: authorized.state.remediationAttempts.at(-1)?.status,
    })}\n`,
  );
}

async function assertRolledBack(kubernetesConfig, { idempotencyKey, target, before }) {
  const after = await waitForDeploymentConvergence(kubernetesConfig, {
    fromRevision: target.fromRevision,
    toTemplateSha256: target.toTemplateSha256,
  });
  const newRevision = Number.parseInt(after.revision ?? "", 10);
  assert(
    Number.isInteger(newRevision) && newRevision > target.fromRevision,
    `Deployment revision did not advance past fromRevision ${target.fromRevision} (observed ${after.revision})`,
  );
  assert(
    templateSha256(after.deployment.spec.template) === target.toTemplateSha256,
    "live PodTemplate digest does not match target.toTemplateSha256 after rollback",
  );
  assert(
    after.deployment.metadata?.uid === target.deploymentUid,
    "Deployment UID changed after rollback",
  );
  const annotations = after.deployment.metadata?.annotations ?? {};
  assert(
    annotations[ROLLBACK_KEY_HASH_ANNOTATION] === hashIdempotencyKey(idempotencyKey),
    "rollback-key-sha256 annotation does not match the idempotency key",
  );
  assert(
    annotations[ROLLBACK_FROM_REVISION_ANNOTATION] === String(target.fromRevision),
    "rollback-from-revision annotation does not match target.fromRevision",
  );
  assert(
    annotations[ROLLBACK_TO_REVISION_ANNOTATION] === String(target.toRevision),
    "rollback-to-revision annotation does not match target.toRevision",
  );
  assert(
    annotations[ROLLBACK_TEMPLATE_HASH_ANNOTATION] === target.toTemplateSha256,
    "rollback-template-sha256 annotation does not match target.toTemplateSha256",
  );
  assert(after.generation !== before.generation, "Deployment generation did not change after rollback");
  return after;
}

async function rollback(rawKubernetesConfig) {
  const record = await readResume();
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const before = await readDeploymentGeneration(kubernetesConfig);

  const invocation = await invokeRollbackTool(record.sessionKey, record.idempotencyKey, record.target);
  assert(invocation.ok === true, `rollback tool call failed: ${JSON.stringify(invocation)}`);
  const details = invocation.output?.details;
  assert(details?.decision === "rolled_back", `unexpected rollback decision: ${JSON.stringify(details)}`);

  const after = await assertRolledBack(kubernetesConfig, {
    idempotencyKey: record.idempotencyKey,
    target: record.target,
    before,
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "rollback",
      decision: details.decision,
      templateSha256: details.templateSha256,
      fromRevision: record.target.fromRevision,
      newRevision: Number.parseInt(after.revision, 10),
      imageBefore: deploymentImage(before),
      imageAfter: deploymentImage(after),
      resourceVersionBefore: before.resourceVersion,
      resourceVersionAfter: after.resourceVersion,
      generationBefore: before.generation,
      generationAfter: after.generation,
    })}\n`,
  );
}

async function replay(rawKubernetesConfig) {
  const record = await readResume();
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const before = await readDeploymentGeneration(kubernetesConfig);

  const invocation = await invokeRollbackTool(record.sessionKey, record.idempotencyKey, record.target);
  assert(invocation.ok === true, `replay tool call failed: ${JSON.stringify(invocation)}`);
  const details = invocation.output?.details;
  assert(details?.decision === "duplicate", `replay did not return duplicate: ${JSON.stringify(details)}`);

  const after = await readDeploymentGeneration(kubernetesConfig);
  assert(after.generation === before.generation, "replay changed Deployment generation (mutated twice)");
  assert(after.resourceVersion === before.resourceVersion, "replay changed Deployment resourceVersion (mutated twice)");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "replay",
      decision: details.decision,
      generationUnchanged: after.generation === before.generation,
      resourceVersionUnchanged: after.resourceVersion === before.resourceVersion,
      generationBefore: before.generation,
      generationAfter: after.generation,
      resourceVersionBefore: before.resourceVersion,
      resourceVersionAfter: after.resourceVersion,
    })}\n`,
  );
}

/**
 * Runs after the Gateway has been restarted but *before*
 * reconcileIncidentOnRestart settles the running attempt -- the persisted
 * IncidentState is still approved + stage=remediation + one running
 * attempt at this point. Replays the exact same idempotencyKey/target
 * through the real guardian_rollback_deployment tools.invoke call (not the
 * reader or gate helper directly) to prove the gate's
 * runtime.getSessionEntry read actually survives a fresh Gateway process,
 * not just the process that originally wrote the state. If the gate had
 * instead failed closed on missing/unreadable state after restart, this
 * call would be blocked with "requires persisted incident state" instead
 * of reaching Kubernetes at all -- so `gateAllowed` alone does not
 * distinguish "correctly read settled state" from "correctly read running
 * state"; the Kubernetes-layer `decision: "duplicate"` and unchanged
 * generation/resourceVersion below are what prove no second mutation was
 * dispatched.
 */
async function postRestartReplay(rawKubernetesConfig) {
  const record = await readResume();
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const before = await readDeploymentGeneration(kubernetesConfig);

  const invocation = await invokeRollbackTool(record.sessionKey, record.idempotencyKey, record.target);
  assert(
    invocation.ok === true,
    `post-restart replay was blocked -- the gate did not read the persisted running attempt after restart: ${JSON.stringify(invocation)}`,
  );
  const details = invocation.output?.details;
  assert(
    details?.decision === "duplicate",
    `post-restart replay did not return duplicate (risk of a second real mutation): ${JSON.stringify(details)}`,
  );

  const after = await readDeploymentGeneration(kubernetesConfig);
  const generationUnchanged = after.generation === before.generation;
  const resourceVersionUnchanged = after.resourceVersion === before.resourceVersion;
  assert(generationUnchanged, "post-restart replay changed Deployment generation (mutated twice)");
  assert(
    resourceVersionUnchanged,
    "post-restart replay changed Deployment resourceVersion (mutated twice)",
  );

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "post-restart-replay",
      gateAllowed: true,
      decision: details.decision,
      generationUnchanged,
      resourceVersionUnchanged,
    })}\n`,
  );
}

async function deniedTarget() {
  const startsAt = now();
  const created = reduceAlertDelivery(undefined, {
    alertId: "kind-deployment-rollback-denied-proof",
    fingerprint: "kind-deployment-rollback-denied-fingerprint",
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "delivery-1",
  });
  assert(created.state, "synthetic denied-target delivery did not create an incident");
  let state = {
    ...created.state,
    stage: "approval",
    proposedAction: "kubernetes_deployment_rollback",
    approvalStatus: "pending",
    evidenceValidation: { status: "passed", checkedAt: startsAt, issues: [] },
    updatedAt: startsAt,
  };

  const deniedTargetValue = {
    type: "kubernetes_deployment_rollback_v1",
    clusterId: "guardian-step3-kind",
    namespace: DENIED_NAMESPACE,
    deployment: DENIED_DEPLOYMENT,
    deploymentUid: "outside-allowlist-uid",
    fromRevision: 2,
    toRevision: 1,
    fromTemplateSha256: "1".repeat(64),
    toTemplateSha256: "2".repeat(64),
  };
  const idempotencyKey = buildIdempotencyKey(state.occurrenceId, deniedTargetValue);
  const authorized = await authorizeRollback(
    DENIED_SESSION_KEY,
    state,
    idempotencyKey,
    deniedTargetValue,
  );
  assert(authorized.decision === "started", `denied-target attempt was not authorized: ${authorized.decision}`);

  const invocation = await client.request("tools.invoke", {
    name: "guardian_rollback_deployment",
    args: { idempotencyKey, target: deniedTargetValue },
    sessionKey: DENIED_SESSION_KEY,
  });
  assert(invocation.ok !== true, "a target outside the allowlist was not denied");

  process.stdout.write(
    `${JSON.stringify({ ok: true, command: "denied-target", denied: true })}\n`,
  );
}

async function reconcile(rawKubernetesConfig) {
  const record = await readResume();
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const state = await readState(record.sessionKey);
  assert(
    state.remediationAttempts.find((a) => a.idempotencyKey === record.idempotencyKey)?.status === "running",
    "expected the rollback attempt to still be running across the simulated crash window",
  );

  const reconciler = new KubernetesDeploymentRollbackReconciler(kubernetesConfig);
  const result = await reconcileIncidentOnRestart({
    state,
    reconciler,
    reconciledAt: now(),
  });
  assert(result.decision === "settled", `reconciliation did not settle: ${result.decision}`);
  assert(
    result.externalOutcome === "confirmed_succeeded",
    `reconciliation did not confirm success: ${result.externalOutcome}`,
  );
  assert(result.state.stage === "recovery_check", `unexpected post-reconciliation stage: ${result.state.stage}`);

  await incidentStore.persistIncidentState(record.sessionKey, result.state);

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "reconcile",
      decision: result.decision,
      externalOutcome: result.externalOutcome,
      stage: result.state.stage,
      attemptStatus: result.state.remediationAttempts.find(
        (a) => a.idempotencyKey === record.idempotencyKey,
      )?.status,
    })}\n`,
  );
}

async function verifyBlockedAfterResolution() {
  const record = await readResume();
  const invocation = await invokeRollbackTool(record.sessionKey, record.idempotencyKey, record.target);
  assert(invocation.ok !== true, "tool call was not blocked after the attempt was already resolved");
  process.stdout.write(
    `${JSON.stringify({ ok: true, command: "verify-blocked-after-resolution", blocked: true })}\n`,
  );
}

/**
 * A second, later incident occurrence against the same Deployment, using a
 * different idempotencyKey than the first rollback. By the time this runs,
 * the bash driver has forward-deployed a new image on top of the first
 * rollback's result, so the Deployment already carries the first attempt's
 * audit annotations under a *different* key. This proves the fix for the
 * bug where any different idempotency key was permanently key_conflict --
 * a legitimate new occurrence must still be allowed to roll the same
 * Deployment back again.
 */
async function secondOccurrence(rawKubernetesConfig) {
  const kubernetesConfig = resolveKubernetesToolConfig({ kubernetes: rawKubernetesConfig });
  const { target } = await discoverRollbackTarget(kubernetesConfig);
  const before = await readDeploymentGeneration(kubernetesConfig);

  const startsAt = now();
  const created = reduceAlertDelivery(undefined, {
    alertId: "kind-deployment-rollback-proof-second-occurrence",
    fingerprint: "kind-deployment-rollback-fingerprint-second-occurrence",
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "delivery-1",
  });
  assert(created.state, "synthetic second-occurrence firing delivery did not create an incident");
  let state = created.state;
  state = {
    ...state,
    stage: "approval",
    proposedAction: "kubernetes_deployment_rollback",
    approvalStatus: "pending",
    evidenceValidation: { status: "passed", checkedAt: startsAt, issues: [] },
    updatedAt: startsAt,
  };

  const idempotencyKey = buildIdempotencyKey(state.occurrenceId, target);
  const authorized = await authorizeRollback(
    SECOND_OCCURRENCE_SESSION_KEY,
    state,
    idempotencyKey,
    target,
  );
  assert(
    authorized.decision === "started",
    `second-occurrence remediation was not authorized: ${authorized.decision}`,
  );

  const invocation = await invokeRollbackTool(SECOND_OCCURRENCE_SESSION_KEY, idempotencyKey, target);
  assert(invocation.ok === true, `second-occurrence rollback tool call failed: ${JSON.stringify(invocation)}`);
  const details = invocation.output?.details;
  assert(
    details?.decision === "rolled_back",
    `second-occurrence rollback with a different idempotency key was not accepted: ${JSON.stringify(details)}`,
  );

  const after = await assertRolledBack(kubernetesConfig, { idempotencyKey, target, before });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command: "second-occurrence",
      decision: details.decision,
      fromRevision: target.fromRevision,
      toRevision: target.toRevision,
      newRevision: Number.parseInt(after.revision, 10),
    })}\n`,
  );
}

async function show() {
  const record = await readResume();
  const state = await readState(record.sessionKey);
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

  const rawKubernetesConfig = JSON.parse(process.env.GUARDIAN_KUBERNETES_CONFIG_JSON ?? "{}");

  if (command === "prepare") {
    await prepare(rawKubernetesConfig);
  } else if (command === "rollback") {
    await rollback(rawKubernetesConfig);
  } else if (command === "replay") {
    await replay(rawKubernetesConfig);
  } else if (command === "denied-target") {
    await deniedTarget();
  } else if (command === "post-restart-replay") {
    await postRestartReplay(rawKubernetesConfig);
  } else if (command === "reconcile") {
    await reconcile(rawKubernetesConfig);
  } else if (command === "verify-blocked-after-resolution") {
    await verifyBlockedAfterResolution();
  } else if (command === "second-occurrence") {
    await secondOccurrence(rawKubernetesConfig);
  } else {
    await show();
  }
}

try {
  await run();
} finally {
  await Promise.all([
    client.stopAndWait({ timeoutMs: 2_000 }),
    incidentStore.close(),
  ]);
}
