import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { createIncidentOccurrenceId, readIncidentStateV3 } from "../dist/state/incident-state.js";
import { beginRemediationAttempt } from "../dist/state/incident-workflow.js";
import { planAlertDeliveryIngestion } from "../dist/alertmanager/ingestion.js";
import {
  GatewayIncidentClient,
  incidentSessionKey,
} from "../dist/alertmanager/http-bridge/gateway-incident-client.js";
import { BridgeStateStore } from "../dist/alertmanager/http-bridge/bridge-state.js";
import { AuditLog } from "../dist/alertmanager/http-bridge/audit.js";
import { drainPendingCheckpoint } from "../dist/alertmanager/http-bridge/processor.js";

const command = process.argv[2];
const bridgeStatePath = process.argv[3];
const markerPath = process.argv[4];

if (!new Set(["crash", "recover"]).has(command)) {
  throw new Error(
    "usage: node scripts/alertmanager-http-bridge-crash-proof.mjs <crash|recover> <bridgeStatePath> <markerPath>",
  );
}
if (!bridgeStatePath || !markerPath) {
  throw new Error("bridgeStatePath and markerPath are required");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

const gatewayUrl = requireEnv("OPENCLAW_GATEWAY_URL");
const gatewayToken = requireEnv("OPENCLAW_GATEWAY_TOKEN");

const fingerprint = "fingerprint-crash-window-proof";

// The bridge stamps `receivedAt` from the real wall clock, so every
// `startsAt` here must stay in the past no matter when this script runs.
// `crash` and `recover` are separate process invocations, so the anchor
// picked by `crash` is persisted to `anchorPath` for `recover` to read back
// before it computes the same deterministic occurrence/session identity.
const anchorPath = join(dirname(bridgeStatePath), "crash-proof-anchor.json");

function loadOrCreateAnchorMs() {
  if (command === "crash") {
    const anchorMs = Date.now() - 3 * 60 * 60 * 1000;
    mkdirSync(dirname(anchorPath), { recursive: true });
    writeFileSync(anchorPath, `${JSON.stringify({ anchorMs })}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return anchorMs;
  }
  return JSON.parse(readFileSync(anchorPath, "utf8")).anchorMs;
}

const anchorMs = loadOrCreateAnchorMs();
const startsAt = new Date(anchorMs).toISOString();
const heldStartsAt = new Date(anchorMs + 60 * 60_000).toISOString();

const occurrenceId = createIncidentOccurrenceId(fingerprint, startsAt);
const sessionKey = incidentSessionKey(occurrenceId);
const heldOccurrenceId = createIncidentOccurrenceId(fingerprint, heldStartsAt);
const heldSessionKey = incidentSessionKey(heldOccurrenceId);

async function connectGateway() {
  const client = new GatewayIncidentClient({
    url: gatewayUrl,
    token: gatewayToken,
    clientDisplayName: "dataops-guardian-crash-window-proof",
    requestTimeoutMs: 10_000,
    connectTimeoutMs: 15_000,
  });
  await client.connect();
  return client;
}

async function crash() {
  const gateway = await connectGateway();
  const bridgeState = new BridgeStateStore(bridgeStatePath);

  const initialDelivery = {
    alertId: "CrashWindowAlert",
    fingerprint,
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "crash-proof-delivery-1",
  };
  const created = planAlertDeliveryIngestion(undefined, initialDelivery);
  assert(created.action === "persist_occurrence", "initial occurrence was not created");
  await gateway.persistIncidentState(sessionKey, created.state);
  bridgeState.setRoute(fingerprint, { occurrenceId, sessionKey });

  const approved = {
    ...created.state,
    stage: "remediation",
    approvalStatus: "approved",
    proposedAction: "synthetic_crash_window_mutation",
  };
  const started = beginRemediationAttempt(approved, {
    idempotencyKey: "crash-window-attempt-1",
    target: { kind: "synthetic_crash_window", resource: "payments" },
    startedAt: new Date(anchorMs + 60_000).toISOString(),
  });
  assert(started.decision === "started", "remediation attempt did not start");
  await gateway.persistIncidentState(sessionKey, started.state);

  const heldDelivery = {
    alertId: "CrashWindowAlert",
    fingerprint,
    alertStatus: "firing",
    startsAt: heldStartsAt,
    endsAt: null,
    receivedAt: new Date(anchorMs + 61 * 60_000).toISOString(),
    deliveryId: "crash-proof-delivery-2",
  };
  const deferredPlan = planAlertDeliveryIngestion(started.state, heldDelivery);
  assert(deferredPlan.action === "hold_deferred_delivery", "delivery was not deferred");
  // This checkpoint write represents the durable hold that already happened
  // before an earlier HTTP 2xx, prior to the crash window under test.
  bridgeState.setCheckpoint(fingerprint, deferredPlan.checkpoint);

  // Simulate the running attempt being settled by restart reconciliation
  // (out of the bridge's scope) before the checkpoint is next drained.
  const settledAt = new Date(anchorMs + 2 * 60_000).toISOString();
  const settledState = {
    ...started.state,
    stage: "recovery_check",
    remediationAttempts: [
      { ...started.state.remediationAttempts[0], status: "succeeded", finishedAt: settledAt, error: null },
    ],
    updatedAt: settledAt,
  };
  await gateway.persistIncidentState(sessionKey, settledState);

  const replayPlan = planAlertDeliveryIngestion(settledState, heldDelivery);
  assert(replayPlan.action === "persist_new_occurrence", "replay did not create a new occurrence");
  assert(replayPlan.occurrenceId === heldOccurrenceId, "replay occurrenceId mismatch");

  // The crash window under test: the destination write below is the last
  // step that must be durable before an HTTP 2xx / checkpoint deletion. We
  // deliberately terminate the process immediately after it completes and
  // before `commitRouteAndClearCheckpoint` runs.
  await gateway.persistIncidentState(heldSessionKey, replayPlan.state);
  writeFileSync(
    markerPath,
    `${JSON.stringify({ destinationWritten: true, occurrenceId: heldOccurrenceId })}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  process.kill(process.pid, "SIGKILL");
}

async function recover() {
  assert(existsSync(markerPath), "crash phase did not reach the destination write");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  assert(marker.destinationWritten === true, "destination write marker missing");

  const gateway = await connectGateway();
  const bridgeState = new BridgeStateStore(bridgeStatePath);
  const audit = new AuditLog(`${bridgeStatePath}.audit.jsonl`);

  // Recovery-time proof of the crash window: the checkpoint is still held
  // and the route still points at the *old* occurrence, even though the new
  // occurrence's destination write already landed durably on the Gateway.
  assert(bridgeState.getCheckpoint(fingerprint) !== undefined, "checkpoint was lost across the crash");
  const routeBeforeDrain = bridgeState.getRoute(fingerprint);
  assert(
    routeBeforeDrain?.occurrenceId === occurrenceId,
    "route moved before the crash, which should not have happened",
  );

  const preDrainHeldValue = await gateway.describeIncidentState(heldSessionKey);
  const preDrainHeldDecoded = readIncidentStateV3(preDrainHeldValue);
  assert(preDrainHeldDecoded.ok, "destination write did not survive the crash");
  assert(
    preDrainHeldDecoded.state.recentDeliveryIds.includes("crash-proof-delivery-2"),
    "destination state is missing the replayed delivery",
  );

  await drainPendingCheckpoint({ bridgeState, gateway, audit, now: () => new Date().toISOString() }, fingerprint);

  assert(bridgeState.getCheckpoint(fingerprint) === undefined, "checkpoint was not cleared after recovery");
  const routeAfterDrain = bridgeState.getRoute(fingerprint);
  assert(
    routeAfterDrain?.occurrenceId === heldOccurrenceId,
    "route did not move to the new occurrence after recovery",
  );

  const postDrainHeldValue = await gateway.describeIncidentState(heldSessionKey);
  const postDrainHeldDecoded = readIncidentStateV3(postDrainHeldValue);
  assert(postDrainHeldDecoded.ok, "destination state failed to decode after recovery");
  assert(
    postDrainHeldDecoded.state.recentDeliveryIds.length === 1,
    "replaying an already-settled checkpoint must not double-count the delivery",
  );

  await gateway.close();

  console.log(
    JSON.stringify({
      ok: true,
      crashWindow: "after_destination_write_before_checkpoint_deletion",
      checkpointCleared: true,
      routedOccurrenceId: routeAfterDrain.occurrenceId,
      deliveryCountAfterRecovery: postDrainHeldDecoded.state.deliveryCount,
    }),
  );
}

if (command === "crash") {
  await crash();
} else {
  await recover();
}
