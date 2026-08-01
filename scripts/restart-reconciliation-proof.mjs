import { readFileSync, writeFileSync } from "node:fs";

import { reduceAlertDelivery } from "../dist/state/incident-reducer.js";
import { beginRemediationAttempt } from "../dist/state/incident-workflow.js";
import { readIncidentStateV3 } from "../dist/state/incident-state.js";
import { reconcileIncidentOnRestart } from "../dist/state/restart-reconciliation.js";

const command = process.argv[2];
const checkpointPath = process.argv[3];
const externalAuditPath = process.argv[4];
const startsAt = "2026-07-25T00:00:00.000Z";
const startedAt = "2026-07-25T00:01:00.000Z";
const reconciledAt = "2026-07-25T00:02:00.000Z";

if (!new Set(["dispatch-and-terminate", "reconcile"]).has(command)) {
  throw new Error(
    "usage: node scripts/restart-reconciliation-proof.mjs <dispatch-and-terminate|reconcile> <checkpoint> <external-audit>",
  );
}
if (!checkpointPath || !externalAuditPath) {
  throw new Error("checkpoint and external-audit paths are required");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function initialDelivery() {
  return {
    alertId: "restart-proof-alert",
    fingerprint: "restart-proof-fingerprint",
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "delivery-1",
  };
}

function deferredDelivery() {
  return {
    ...initialDelivery(),
    alertId: "restart-proof-alert-next",
    startsAt: "2026-07-25T01:00:00.000Z",
    receivedAt: "2026-07-25T01:00:01.000Z",
    deliveryId: "delivery-next",
  };
}

function dispatchAndTerminate() {
  const created = reduceAlertDelivery(undefined, initialDelivery());
  assert(created.state, "initial incident was not created");
  const approved = {
    ...created.state,
    stage: "remediation",
    approvalStatus: "approved",
    proposedAction: "synthetic_restart_proof_mutation",
  };
  const started = beginRemediationAttempt(approved, {
    idempotencyKey: "restart-proof-attempt-1",
    target: {
      kind: "synthetic_restart_proof",
      resource: "payments",
      revision: 1,
    },
    startedAt,
  });
  assert(started.decision === "started", "remediation attempt did not start");

  const deferred = deferredDelivery();
  const deferredResult = reduceAlertDelivery(started.state, deferred);
  assert(
    deferredResult.decision === "deferred_new_occurrence",
    "next delivery was not deferred",
  );

  writeFileSync(
    checkpointPath,
    `${JSON.stringify({
      incidentState: started.state,
      deferredDelivery: deferred,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );

  // This write is the synthetic external mutation. The process is killed after
  // dispatch/effect persistence and before IncidentState result persistence.
  writeFileSync(
    externalAuditPath,
    `${JSON.stringify({
      dispatchCount: 1,
      idempotencyKey: "restart-proof-attempt-1",
      target: started.state.remediationAttempts[0].target,
      effectApplied: true,
    })}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  process.kill(process.pid, "SIGKILL");
}

async function reconcile() {
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  const externalAudit = JSON.parse(readFileSync(externalAuditPath, "utf8"));
  assert(
    externalAudit.dispatchCount === 1,
    "crash fixture did not persist exactly one mutation dispatch",
  );
  const decoded = readIncidentStateV3(checkpoint.incidentState);
  assert(decoded.ok, "persisted running incident failed validation");
  assert(
    decoded.state.remediationAttempts[0]?.status === "running",
    "proof checkpoint unexpectedly contains a persisted result",
  );

  const result = await reconcileIncidentOnRestart({
    state: decoded.state,
    deferredDelivery: checkpoint.deferredDelivery,
    reconciledAt,
    reconciler: {
      async reconcile(request) {
        const targetMatches =
          JSON.stringify(request.target) === JSON.stringify(externalAudit.target);
        if (
          externalAudit.dispatchCount === 1 &&
          externalAudit.effectApplied === true &&
          externalAudit.idempotencyKey === request.idempotencyKey &&
          targetMatches
        ) {
          return {
            outcome: "confirmed_succeeded",
            summary:
              "Synthetic external audit confirms the dispatched effect.",
          };
        }
        return {
          outcome: "unknown",
          summary: "Synthetic external audit is inconclusive.",
        };
      },
    },
  });

  assert(result.decision === "settled", "running attempt was not settled");
  assert(
    result.externalOutcome === "confirmed_succeeded",
    "external success was not confirmed",
  );
  assert(
    result.state.remediationAttempts[0]?.idempotencyKey ===
      "restart-proof-attempt-1" &&
      result.state.remediationAttempts[0]?.status === "succeeded",
    "the original attempt was not settled as succeeded",
  );
  assert(
    result.deferredDelivery.disposition === "replayed" &&
      result.deferredDelivery.result.decision === "new_occurrence",
    "held delivery was not safely replayed",
  );
  const externalAuditAfter = JSON.parse(
    readFileSync(externalAuditPath, "utf8"),
  );
  assert(
    externalAuditAfter.dispatchCount === 1,
    "mutation dispatch count changed during restart reconciliation",
  );

  const routed = reduceAlertDelivery(
    undefined,
    result.deferredDelivery.delivery,
  );
  assert(routed.decision === "created", "replayed delivery was not routable");

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      crashWindow: "after_mutation_dispatch_before_result_persistence",
      recoveredAttemptKey:
        result.state.remediationAttempts[0].idempotencyKey,
      recoveredAttemptStatus: result.state.remediationAttempts[0].status,
      mutationDispatchCount: externalAuditAfter.dispatchCount,
      deferredDelivery: result.deferredDelivery.disposition,
      replayDecision: result.deferredDelivery.result.decision,
      routedOccurrence: routed.state.occurrenceId,
    })}\n`,
  );
}

if (command === "dispatch-and-terminate") {
  dispatchAndTerminate();
} else {
  await reconcile();
}
