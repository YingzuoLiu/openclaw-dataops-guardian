import { describe, expect, it } from "vitest";

import { inspectMetricSnapshot } from "../tools/inspect-metric-snapshot.js";
import { proposeRemediation } from "../tools/propose-remediation.js";
import { reduceAlertDelivery } from "./incident-reducer.js";
import {
  beginRemediationAttempt,
  finishRemediationAttempt,
  recordApprovalDecision,
  recordMetricEvidence,
  recordRecoveryCheck,
  recordRemediationProposal,
} from "./incident-workflow.js";
import {
  MAX_REMEDIATION_ATTEMPTS,
  type IncidentState,
  type RemediationTarget,
} from "./incident-state.js";

const at = "2026-07-25T00:00:00.000Z";
const syntheticTarget: RemediationTarget = {
  kind: "synthetic",
  action: "rollback_latest_release",
};

function openedIncident(): IncidentState {
  const result = reduceAlertDelivery(undefined, {
    alertId: "payment-success-rate-drop",
    fingerprint: "alert-fingerprint",
    alertStatus: "firing",
    startsAt: at,
    endsAt: null,
    receivedAt: at,
    deliveryId: "delivery-1",
  });
  if (!result.state) {
    throw new Error("fixture incident was not created");
  }
  return result.state;
}

function approvedIncident(): IncidentState {
  const metric = inspectMetricSnapshot({
    alertId: "payment-success-rate-drop",
    metric: "payment_success_rate",
    currentValue: 0.7,
    baselineValue: 1,
    source: "prometheus:payment_success_rate",
  });
  const proposal = proposeRemediation({
    alertId: "payment-success-rate-drop",
    metric: "payment_success_rate",
    classification: metric.classification,
  });

  let state = openedIncident();
  state = recordMetricEvidence(state, metric, at);
  state = recordRemediationProposal(state, proposal, at);
  return recordApprovalDecision(state, true, at);
}

function startAttempt(
  state: IncidentState,
  idempotencyKey: string,
  target: RemediationTarget = syntheticTarget,
) {
  return beginRemediationAttempt(state, {
    idempotencyKey,
    target,
    startedAt: at,
  });
}

describe("incident vertical slice reducer", () => {
  it("reaches completed after evidence, approval, remediation, and recovery", () => {
    let state = approvedIncident();
    const started = startAttempt(state, "attempt-1");
    expect(started.decision).toBe("started");
    state = started.state;

    const finished = finishRemediationAttempt(state, {
      idempotencyKey: "attempt-1",
      status: "succeeded",
      finishedAt: at,
      error: null,
    });
    expect(finished.decision).toBe("recorded");
    state = recordRecoveryCheck(finished.state, {
      healthy: true,
      summary: "Payment success rate recovered.",
      checkedAt: at,
    });

    expect(state).toMatchObject({
      stage: "completed",
      approvalStatus: "approved",
      evidenceValidation: { status: "passed", issues: [] },
      proposedAction: "rollback_latest_release",
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          status: "succeeded",
        },
      ],
    });
  });

  it("blocks a denied remediation and rejects unsupported evidence", () => {
    const metric = inspectMetricSnapshot({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
      source: "supplied_snapshot",
    });
    const proposal = proposeRemediation({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      classification: metric.classification,
    });
    let state = openedIncident();
    state = recordMetricEvidence(state, metric, at);
    state = recordRemediationProposal(state, proposal, at);

    expect(state).toMatchObject({
      stage: "evidence_collection",
      approvalStatus: "not_requested",
      evidenceValidation: {
        status: "failed",
        issues: ["required evidence source is missing: prometheus:"],
      },
    });

    const approved = approvedIncident();
    const approvalState = {
      ...approved,
      stage: "approval" as const,
      approvalStatus: "pending" as const,
    };
    expect(recordApprovalDecision(approvalState, false, at)).toMatchObject({
      stage: "blocked",
      approvalStatus: "denied",
    });
  });
});

describe("remediation attempt history", () => {
  it("returns duplicate for the same key and target, and conflict for a changed target", () => {
    const state = approvedIncident();
    const started = startAttempt(state, "attempt-1", {
      action: "rollback_latest_release",
      kind: "synthetic",
      nested: { value: 1 },
    });

    expect(
      startAttempt(started.state, "attempt-1", {
        nested: { value: 1 },
        kind: "synthetic",
        action: "rollback_latest_release",
      }),
    ).toMatchObject({ decision: "duplicate" });
    expect(
      startAttempt(started.state, "attempt-1", {
        action: "different",
        kind: "synthetic",
      }),
    ).toMatchObject({
      decision: "idempotency_conflict",
    });
  });

  it("rejects a different key while an attempt is running and mismatched results", () => {
    const started = startAttempt(approvedIncident(), "attempt-1");
    expect(startAttempt(started.state, "attempt-2")).toMatchObject({
      decision: "running_attempt_exists",
    });
    expect(
      finishRemediationAttempt(started.state, {
        idempotencyKey: "attempt-2",
        status: "succeeded",
        finishedAt: at,
        error: null,
      }),
    ).toMatchObject({
      decision: "running_key_mismatch",
    });
  });

  it("allows a new key after recovery failure while old keys remain duplicate", () => {
    let state = approvedIncident();
    state = startAttempt(state, "attempt-1").state;
    state = finishRemediationAttempt(state, {
      idempotencyKey: "attempt-1",
      status: "succeeded",
      finishedAt: at,
      error: null,
    }).state;
    state = recordRecoveryCheck(state, {
      healthy: false,
      summary: "Still unhealthy.",
      checkedAt: at,
    });

    expect(startAttempt(state, "attempt-1")).toMatchObject({
      decision: "duplicate",
    });
    expect(startAttempt(state, "attempt-2")).toMatchObject({
      decision: "started",
    });
  });

  it("uses remediationAttempts.length as the only retry budget", () => {
    let state = approvedIncident();

    for (let attempt = 1; attempt <= MAX_REMEDIATION_ATTEMPTS; attempt += 1) {
      const key = `attempt-${attempt}`;
      state = startAttempt(state, key).state;
      state = finishRemediationAttempt(state, {
        idempotencyKey: key,
        status: "succeeded",
        finishedAt: at,
        error: null,
      }).state;
      state = recordRecoveryCheck(state, {
        healthy: false,
        summary: `Recovery ${attempt} failed.`,
        checkedAt: at,
      });
    }

    expect(state).toMatchObject({
      stage: "blocked",
      remediationAttempts: { length: MAX_REMEDIATION_ATTEMPTS },
    });
    expect(startAttempt(state, "attempt-over-limit")).toMatchObject({
      decision: "attempt_limit_reached",
    });
  });

  it("returns to remediation after execution failure until the attempt budget is exhausted", () => {
    let state = approvedIncident();

    for (let attempt = 1; attempt <= MAX_REMEDIATION_ATTEMPTS; attempt += 1) {
      const key = `attempt-${attempt}`;
      state = startAttempt(state, key).state;
      state = finishRemediationAttempt(state, {
        idempotencyKey: key,
        status: "failed",
        finishedAt: at,
        error: `Execution ${attempt} failed.`,
      }).state;
    }

    expect(state.stage).toBe("blocked");
    expect(state.remediationAttempts).toHaveLength(
      MAX_REMEDIATION_ATTEMPTS,
    );
  });
});
