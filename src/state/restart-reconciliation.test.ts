import { describe, expect, it, vi } from "vitest";

import {
  reduceAlertDelivery,
  type AlertDelivery,
} from "./incident-reducer.js";
import { beginRemediationAttempt } from "./incident-workflow.js";
import { readIncidentStateV3, type IncidentState } from "./incident-state.js";
import {
  isRestartReconciliationManualReview,
  reconcileIncidentOnRestart,
  type ExternalReconciliationOutcome,
  type ExternalRemediationReconciler,
} from "./restart-reconciliation.js";

const startsAt = "2026-07-25T00:00:00.000Z";
const startedAt = "2026-07-25T00:01:00.000Z";
const reconciledAt = "2026-07-25T00:02:00.000Z";

function delivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    alertId: "payment-success-rate-drop",
    fingerprint: "alert-fingerprint",
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    receivedAt: startsAt,
    deliveryId: "delivery-1",
    ...overrides,
  };
}

function runningIncident(): IncidentState {
  const created = reduceAlertDelivery(undefined, delivery());
  if (!created.state) {
    throw new Error("fixture incident was not created");
  }
  const approved: IncidentState = {
    ...created.state,
    stage: "remediation",
    approvalStatus: "approved",
    proposedAction: "rollback_latest_release",
  };
  const started = beginRemediationAttempt(approved, {
    idempotencyKey: "attempt-1",
    target: {
      kind: "synthetic",
      action: "rollback_latest_release",
      revision: 1,
    },
    startedAt,
  });
  if (started.decision !== "started") {
    throw new Error("fixture remediation attempt was not started");
  }
  return started.state;
}

function reconciler(outcome: ExternalReconciliationOutcome): {
  implementation: ExternalRemediationReconciler;
  reconcile: ReturnType<typeof vi.fn>;
} {
  const reconcile = vi.fn().mockResolvedValue(outcome);
  return {
    implementation: { reconcile },
    reconcile,
  };
}

describe("restart reconciliation", () => {
  it("records confirmed success for the existing key and target", async () => {
    const external = reconciler({
      outcome: "confirmed_succeeded",
      summary: "External audit confirms the requested effect.",
    });

    const result = await reconcileIncidentOnRestart({
      state: runningIncident(),
      reconciler: external.implementation,
      reconciledAt,
    });

    expect(external.reconcile).toHaveBeenCalledWith({
      idempotencyKey: "attempt-1",
      target: {
        kind: "synthetic",
        action: "rollback_latest_release",
        revision: 1,
      },
      startedAt,
    });
    expect(result).toMatchObject({
      decision: "settled",
      externalOutcome: "confirmed_succeeded",
      state: {
        stage: "recovery_check",
        remediationAttempts: [
          {
            idempotencyKey: "attempt-1",
            status: "succeeded",
            finishedAt: reconciledAt,
            error: null,
          },
        ],
      },
      deferredDelivery: { disposition: "none" },
    });
    expect(readIncidentStateV3(result.state).ok).toBe(true);
  });

  it("records confirmed failure and only then returns to the ordinary retry path", async () => {
    const result = await reconcileIncidentOnRestart({
      state: runningIncident(),
      reconciler: reconciler({
        outcome: "confirmed_failed",
        summary: "External audit confirms dispatch was rejected.",
      }).implementation,
      reconciledAt,
    });

    expect(result).toMatchObject({
      decision: "settled",
      externalOutcome: "confirmed_failed",
      state: {
        stage: "remediation",
        remediationAttempts: [
          {
            idempotencyKey: "attempt-1",
            status: "failed",
            error: "External audit confirms dispatch was rejected.",
          },
        ],
      },
    });
    expect(
      beginRemediationAttempt(result.state, {
        idempotencyKey: "attempt-2",
        target: { kind: "synthetic", revision: 2 },
        startedAt: reconciledAt,
      }).decision,
    ).toBe("started");
  });

  it("blocks after confirmed failure when the attempt budget is exhausted", async () => {
    const running = runningIncident();
    const exhausted: IncidentState = {
      ...running,
      remediationAttempts: [
        {
          idempotencyKey: "attempt-before-1",
          target: { kind: "synthetic", revision: 0 },
          status: "failed",
          startedAt: startsAt,
          finishedAt: startsAt,
          error: "Confirmed failure one.",
        },
        {
          idempotencyKey: "attempt-before-2",
          target: { kind: "synthetic", revision: 0 },
          status: "failed",
          startedAt: startsAt,
          finishedAt: startsAt,
          error: "Confirmed failure two.",
        },
        ...running.remediationAttempts,
      ],
    };

    const result = await reconcileIncidentOnRestart({
      state: exhausted,
      reconciler: reconciler({
        outcome: "confirmed_failed",
        summary: "External audit confirms the final dispatch was rejected.",
      }).implementation,
      reconciledAt,
    });

    expect(result).toMatchObject({
      decision: "settled",
      externalOutcome: "confirmed_failed",
      state: {
        stage: "blocked",
        remediationAttempts: [{ status: "failed" }, { status: "failed" }, { status: "failed" }],
      },
    });
    expect(readIncidentStateV3(result.state).ok).toBe(true);
    expect(
      beginRemediationAttempt(result.state, {
        idempotencyKey: "attempt-4",
        target: { kind: "synthetic", revision: 2 },
        startedAt: reconciledAt,
      }).decision,
    ).toBe("attempt_limit_reached");
  });

  it("fails closed for an unknown outcome without consuming a failure or replaying delivery", async () => {
    const deferred = delivery({
      alertId: "payment-success-rate-drop-v2",
      startsAt: "2026-07-25T01:00:00.000Z",
      receivedAt: "2026-07-25T01:00:01.000Z",
      deliveryId: "next-occurrence-delivery",
    });
    const result = await reconcileIncidentOnRestart({
      state: runningIncident(),
      reconciler: reconciler({
        outcome: "unknown",
        summary: "External audit cannot establish whether dispatch took effect.",
      }).implementation,
      reconciledAt,
      deferredDelivery: deferred,
    });

    expect(result).toMatchObject({
      decision: "manual_review",
      externalOutcome: "unknown",
      state: {
        stage: "blocked",
        remediationAttempts: [
          {
            idempotencyKey: "attempt-1",
            status: "running",
            finishedAt: null,
            error: null,
          },
        ],
      },
      deferredDelivery: {
        disposition: "held",
        delivery: deferred,
      },
    });
    expect(isRestartReconciliationManualReview(result.state)).toBe(true);
    expect(readIncidentStateV3(result.state).ok).toBe(true);
    expect(
      beginRemediationAttempt(result.state, {
        idempotencyKey: "attempt-2",
        target: { kind: "synthetic", revision: 2 },
        startedAt: reconciledAt,
      }).decision,
    ).toBe("running_attempt_exists");
    expect(reduceAlertDelivery(result.state, deferred).decision).toBe(
      "deferred_new_occurrence",
    );
  });

  it("normalizes a malformed external result to unknown", async () => {
    const state = runningIncident();
    const result = await reconcileIncidentOnRestart({
      state,
      reconciler: {
        reconcile: vi.fn().mockResolvedValue({
          outcome: "confirmed_failed",
          summary: "",
        }),
      },
      reconciledAt,
    });

    expect(result).toMatchObject({
      decision: "manual_review",
      externalOutcome: "unknown",
      state: {
        stage: "blocked",
        remediationAttempts: [{ status: "running" }],
      },
    });
    expect(readIncidentStateV3(result.state).ok).toBe(true);
  });

  it("leaves the supplied state untouched when external reconciliation throws", async () => {
    const state = runningIncident();
    const snapshot = structuredClone(state);

    await expect(
      reconcileIncidentOnRestart({
        state,
        reconciler: {
          reconcile: vi.fn().mockRejectedValue(new Error("audit unavailable")),
        },
        reconciledAt,
      }),
    ).rejects.toThrow("audit unavailable");

    expect(state).toEqual(snapshot);
    expect(state.remediationAttempts[0]?.status).toBe("running");
  });

  it("replays a held delivery only after the previous attempt is safely settled", async () => {
    const deferred = delivery({
      alertId: "payment-success-rate-drop-v2",
      startsAt: "2026-07-25T01:00:00.000Z",
      receivedAt: "2026-07-25T01:00:01.000Z",
      deliveryId: "next-occurrence-delivery",
    });
    const beforeRestart = reduceAlertDelivery(runningIncident(), deferred);
    expect(beforeRestart.decision).toBe("deferred_new_occurrence");
    if (beforeRestart.decision !== "deferred_new_occurrence") {
      throw new Error("fixture delivery was not deferred");
    }

    const result = await reconcileIncidentOnRestart({
      state: beforeRestart.state,
      reconciler: reconciler({
        outcome: "confirmed_succeeded",
        summary: "External audit confirms the requested effect.",
      }).implementation,
      reconciledAt,
      deferredDelivery: deferred,
    });

    expect(result.deferredDelivery).toMatchObject({
      disposition: "replayed",
      delivery: deferred,
      result: { decision: "new_occurrence" },
    });
    if (result.deferredDelivery.disposition !== "replayed") {
      throw new Error("deferred delivery was not replayed");
    }
    const routed = reduceAlertDelivery(
      undefined,
      result.deferredDelivery.delivery,
    );
    expect(routed).toMatchObject({
      decision: "created",
      state: {
        alertId: "payment-success-rate-drop-v2",
        deliveryCount: 1,
        recentDeliveryIds: ["next-occurrence-delivery"],
      },
    });
  });

  it("can settle a manual-review block on a later restart once evidence becomes conclusive", async () => {
    const first = await reconcileIncidentOnRestart({
      state: runningIncident(),
      reconciler: reconciler({
        outcome: "unknown",
        summary: "First inspection is inconclusive.",
      }).implementation,
      reconciledAt,
    });
    const second = await reconcileIncidentOnRestart({
      state: first.state,
      reconciler: reconciler({
        outcome: "confirmed_succeeded",
        summary: "Manual review found the external success record.",
      }).implementation,
      reconciledAt: "2026-07-25T00:03:00.000Z",
    });

    expect(second).toMatchObject({
      decision: "settled",
      state: {
        stage: "recovery_check",
        remediationAttempts: [{ status: "succeeded" }],
      },
    });
  });
});
