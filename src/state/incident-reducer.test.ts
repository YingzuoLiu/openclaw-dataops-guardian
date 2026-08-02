import { describe, expect, it } from "vitest";

import {
  MAX_RECENT_DELIVERY_IDS,
  reduceAlertDelivery,
  type AlertDelivery,
  type AlertDeliveryResult,
} from "./incident-reducer.js";
import { readIncidentStateV3 } from "./incident-state.js";
import {
  beginRemediationAttempt,
  recordApprovalDecision,
  recordMetricEvidence,
  recordRemediationProposal,
} from "./incident-workflow.js";

const startsAt = "2026-07-25T00:00:00.000Z";

function assertNever(value: never): never {
  throw new Error(`unhandled delivery result: ${JSON.stringify(value)}`);
}

function classifyDecision(result: AlertDeliveryResult): string {
  switch (result.decision) {
    case "created":
    case "updated":
    case "duplicate":
    case "new_occurrence":
    case "deferred_new_occurrence":
    case "orphan_resolved":
    case "stale_refire":
    case "rejected":
      return result.decision;
    default:
      return assertNever(result);
  }
}

function delivery(
  overrides: Partial<AlertDelivery> = {},
): AlertDelivery {
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

describe("reduceAlertDelivery", () => {
  it("creates schema v3 only from a firing delivery", () => {
    const result = reduceAlertDelivery(undefined, delivery());

    expect(result).toMatchObject({
      decision: "created",
      state: {
        schemaVersion: 3,
        alertStatus: "firing",
        deliveryCount: 1,
        nonDuplicateDeliveryCount: 1,
        recentDeliveryIds: ["delivery-1"],
        remediationAttempts: [],
      },
    });
  });

  it("counts a retained duplicate without counting it as non-duplicate", () => {
    const created = reduceAlertDelivery(undefined, delivery());
    const duplicate = reduceAlertDelivery(
      created.state,
      delivery({
        receivedAt: "2026-07-25T00:01:00.000Z",
      }),
    );

    expect(duplicate).toMatchObject({
      decision: "duplicate",
      state: {
        deliveryCount: 2,
        nonDuplicateDeliveryCount: 1,
        lastReceivedAt: "2026-07-25T00:01:00.000Z",
        updatedAt: "2026-07-25T00:01:00.000Z",
      },
    });
  });

  it("retains only the 50 most recent unique delivery IDs", () => {
    let result = reduceAlertDelivery(undefined, delivery());

    for (let index = 2; index <= MAX_RECENT_DELIVERY_IDS + 1; index += 1) {
      result = reduceAlertDelivery(
        result.state,
        delivery({
          deliveryId: `delivery-${index}`,
          receivedAt: `2026-07-25T00:${String(index).padStart(2, "0")}:00.000Z`,
        }),
      );
    }

    expect(result.state?.recentDeliveryIds).toHaveLength(
      MAX_RECENT_DELIVERY_IDS,
    );
    expect(result.state?.recentDeliveryIds[0]).toBe("delivery-2");
    expect(result.state?.recentDeliveryIds.at(-1)).toBe("delivery-51");
    expect(result.state).toMatchObject({
      deliveryCount: 51,
      nonDuplicateDeliveryCount: 51,
    });

    const evictedReplay = reduceAlertDelivery(
      result.state,
      delivery({
        deliveryId: "delivery-1",
        receivedAt: "2026-07-25T01:00:00.000Z",
      }),
    );
    expect(evictedReplay).toMatchObject({
      decision: "updated",
      state: {
        deliveryCount: 52,
        nonDuplicateDeliveryCount: 52,
      },
    });
  });

  it("distinguishes lifecycle and occurrence decisions", () => {
    const orphan = reduceAlertDelivery(
      undefined,
      delivery({
        alertStatus: "resolved",
        endsAt: "2026-07-25T00:05:00.000Z",
      }),
    );
    expect(orphan.decision).toBe("orphan_resolved");

    const created = reduceAlertDelivery(undefined, delivery());
    const resolved = reduceAlertDelivery(
      created.state,
      delivery({
        alertStatus: "resolved",
        endsAt: "2026-07-25T00:05:00.000Z",
        receivedAt: "2026-07-25T00:05:00.000Z",
        deliveryId: "delivery-2",
      }),
    );
    expect(resolved).toMatchObject({
      decision: "updated",
      state: {
        alertStatus: "resolved",
        endsAt: "2026-07-25T00:05:00.000Z",
        stage: "alert_received",
      },
    });

    const staleRefire = reduceAlertDelivery(
      resolved.state,
      delivery({
        deliveryId: "delivery-3",
        receivedAt: "2026-07-25T00:06:00.000Z",
      }),
    );
    expect(staleRefire).toMatchObject({
      decision: "stale_refire",
      state: {
        alertStatus: "resolved",
        deliveryCount: 3,
        nonDuplicateDeliveryCount: 3,
      },
    });

    const nextOccurrence = reduceAlertDelivery(
      resolved.state,
      delivery({
        startsAt: "2026-07-25T01:00:00.000Z",
        receivedAt: "2026-07-25T01:00:00.000Z",
        deliveryId: "next-delivery",
      }),
    );
    expect(nextOccurrence).toMatchObject({
      decision: "new_occurrence",
    });
    expect(nextOccurrence).not.toHaveProperty("reason");
    expect(nextOccurrence.state).toBe(resolved.state);
  });

  it("preserves a running remediation occurrence when a new firing occurrence arrives", () => {
    const created = reduceAlertDelivery(undefined, delivery());
    if (!created.state) {
      throw new Error("fixture incident was not created");
    }
    const remediationState = {
      ...created.state,
      stage: "remediation" as const,
      approvalStatus: "approved" as const,
      proposedAction: "rollback_latest_release",
    };
    const started = beginRemediationAttempt(remediationState, {
      idempotencyKey: "attempt-1",
      target: { kind: "synthetic" },
      startedAt: startsAt,
    });
    if (started.decision !== "started") {
      throw new Error("fixture remediation attempt was not started");
    }
    const before = structuredClone(started.state);

    const result = reduceAlertDelivery(
      started.state,
      delivery({
        alertId: "payment-success-rate-drop-v2",
        startsAt: "2026-07-25T01:00:00.000Z",
        receivedAt: "2026-07-25T01:00:01.000Z",
        deliveryId: "next-occurrence-delivery",
      }),
    );

    expect(result).toMatchObject({
      decision: "deferred_new_occurrence",
    });
    expect(classifyDecision(result)).toBe("deferred_new_occurrence");
    expect(result).not.toHaveProperty("reason");
    expect(result.state).toBe(started.state);
    expect(result.state).toEqual(before);
    expect(result.state?.remediationAttempts).toEqual(
      started.state.remediationAttempts,
    );
  });

  it("routes a new firing occurrence without replacing the old state", () => {
    const created = reduceAlertDelivery(undefined, delivery());
    if (!created.state) {
      throw new Error("fixture incident was not created");
    }
    const before = structuredClone(created.state);
    const nextDelivery = delivery({
      alertId: "renamed-payment-alert",
      startsAt: "2026-07-25T01:00:00.000Z",
      receivedAt: "2026-07-25T01:00:05.000Z",
      deliveryId: "next-occurrence-delivery",
    });

    const routed = reduceAlertDelivery(created.state, nextDelivery);

    expect(routed).toMatchObject({
      decision: "new_occurrence",
    });
    expect(routed).not.toHaveProperty("reason");
    expect(routed.state).toBe(created.state);
    expect(routed.state).toEqual(before);

    const newOccurrence = reduceAlertDelivery(undefined, nextDelivery);
    expect(newOccurrence).toMatchObject({
      decision: "created",
      state: {
        alertId: "renamed-payment-alert",
        startsAt: "2026-07-25T01:00:00.000Z",
        remediationAttempts: [],
      },
    });
    expect(newOccurrence.state?.occurrenceId).not.toBe(
      created.state.occurrenceId,
    );
  });

  it("rejects invalid delivery input and unsupported stored schemas", () => {
    expect(
      reduceAlertDelivery(undefined, delivery({ deliveryId: " " })),
    ).toMatchObject({ decision: "rejected" });
    expect(
      reduceAlertDelivery(
        { schemaVersion: 2, alertId: "legacy" },
        delivery(),
      ),
    ).toMatchObject({
      decision: "rejected",
      reason: "unsupported_schema",
    });
  });

  describe("updatedAt stays monotonic under late-but-valid deliveries", () => {
    function incidentWithRunningRemediation() {
      const created = reduceAlertDelivery(
        undefined,
        delivery({ receivedAt: "2026-08-01T00:00:05.000Z" }),
      );
      if (created.decision !== "created") {
        throw new Error("fixture incident was not created");
      }
      const withEvidence = recordMetricEvidence(
        created.state,
        {
          alertId: delivery().alertId,
          metric: "payment_success_rate",
          currentValue: 42,
          baselineValue: 99,
          relativeChange: -0.57,
          classification: "critical",
          source: "prometheus:payment_success_rate",
          evidenceSummary: "healthy sample",
        },
        "2026-08-01T00:03:00.000Z",
      );
      const withProposal = recordRemediationProposal(
        withEvidence,
        {
          alertId: delivery().alertId,
          action: "rollback_deployment",
          rationale: "evidence-backed rollback",
          risk: "low",
        },
        "2026-08-01T00:04:00.000Z",
      );
      if (withProposal.evidenceValidation.status !== "passed") {
        throw new Error(
          `fixture evidence validation did not pass: ${JSON.stringify(withProposal.evidenceValidation)}`,
        );
      }
      const approved = recordApprovalDecision(
        withProposal,
        true,
        "2026-08-01T00:04:30.000Z",
      );
      const running = beginRemediationAttempt(approved, {
        idempotencyKey: "mutation-key-1",
        target: { namespace: "guardian-demo", deployment: "payments" },
        startedAt: "2026-08-01T00:05:00.000Z",
      });
      if (running.decision !== "started") {
        throw new Error("fixture remediation attempt was not started");
      }
      return running.state;
    }

    it("does not regress updatedAt when a duplicate delivery replays after remediation began", () => {
      const runningState = incidentWithRunningRemediation();
      // An Alertmanager retry (or an HA-replica duplicate) of the delivery that created this
      // incident, arriving a few seconds after ingestion but long after remediation started.
      const retriedOriginal = delivery({
        receivedAt: "2026-08-01T00:00:07.000Z",
      });

      const result = reduceAlertDelivery(runningState, retriedOriginal);

      expect(result).toMatchObject({
        decision: "duplicate",
        state: {
          // lastReceivedAt still reflects delivery-ingestion order.
          lastReceivedAt: "2026-08-01T00:00:07.000Z",
          // updatedAt must not regress behind the running attempt's startedAt.
          updatedAt: "2026-08-01T00:05:00.000Z",
        },
      });
      expect(result.state?.updatedAt).toBe(runningState.updatedAt);
      expect(readIncidentStateV3(result.state)).toMatchObject({ ok: true });

      const nextDelivery = delivery({
        deliveryId: "delivery-legit-followup",
        receivedAt: "2026-08-01T00:06:00.000Z",
      });
      const afterFollowup = reduceAlertDelivery(result.state, nextDelivery);
      expect(afterFollowup.decision).not.toBe("rejected");
    });

    it("does not regress updatedAt when a resolved delivery for the same occurrence arrives late", () => {
      const runningState = incidentWithRunningRemediation();
      const lateResolved = delivery({
        alertStatus: "resolved",
        endsAt: "2026-08-01T00:00:30.000Z",
        receivedAt: "2026-08-01T00:00:10.000Z",
        deliveryId: "delivery-late-resolved",
      });

      const result = reduceAlertDelivery(runningState, lateResolved);

      expect(result).toMatchObject({
        decision: "updated",
        state: {
          alertStatus: "resolved",
          stage: "remediation",
          lastReceivedAt: "2026-08-01T00:00:10.000Z",
          updatedAt: "2026-08-01T00:05:00.000Z",
        },
      });
      expect(result.state?.updatedAt).toBe(runningState.updatedAt);
      expect(readIncidentStateV3(result.state)).toMatchObject({ ok: true });

      const nextDelivery = delivery({
        deliveryId: "delivery-legit-followup-2",
        receivedAt: "2026-08-01T00:06:00.000Z",
      });
      const afterFollowup = reduceAlertDelivery(result.state, nextDelivery);
      expect(afterFollowup.decision).not.toBe("rejected");
    });

    it("does not regress updatedAt when a stale refire arrives after post-resolution evidence work", () => {
      const created = reduceAlertDelivery(
        undefined,
        delivery({ receivedAt: "2026-07-25T00:00:05.000Z" }),
      );
      if (created.decision !== "created") {
        throw new Error("fixture incident was not created");
      }
      const resolved = reduceAlertDelivery(
        created.state,
        delivery({
          alertStatus: "resolved",
          endsAt: "2026-07-25T00:00:30.000Z",
          receivedAt: "2026-07-25T00:01:00.000Z",
          deliveryId: "delivery-2",
        }),
      );
      if (resolved.decision !== "updated") {
        throw new Error("fixture incident was not resolved");
      }
      // Independent, non-delivery-driven work keeps advancing the incident's logical clock
      // well past this resolved delivery's own receivedAt.
      const withEvidence = recordMetricEvidence(
        resolved.state,
        {
          alertId: delivery().alertId,
          metric: "payment_success_rate",
          currentValue: 98,
          baselineValue: 99,
          relativeChange: -0.01,
          classification: "within_expected_range",
          source: "prometheus:payment_success_rate",
          evidenceSummary: "recheck",
        },
        "2026-07-25T00:10:00.000Z",
      );

      // A stale refire for the same occurrence, delayed in flight, still satisfies the
      // lastReceivedAt ordering check (>= 00:01:00) but is far behind the current updatedAt.
      const staleRefire = reduceAlertDelivery(
        withEvidence,
        delivery({
          receivedAt: "2026-07-25T00:01:30.000Z",
          deliveryId: "delivery-3-stale",
        }),
      );

      expect(staleRefire).toMatchObject({
        decision: "stale_refire",
        state: {
          alertStatus: "resolved",
          lastReceivedAt: "2026-07-25T00:01:30.000Z",
          updatedAt: "2026-07-25T00:10:00.000Z",
        },
      });
      expect(staleRefire.state?.updatedAt).toBe(withEvidence.updatedAt);
      expect(readIncidentStateV3(staleRefire.state)).toMatchObject({ ok: true });

      const nextDelivery = delivery({
        deliveryId: "delivery-legit-followup-3",
        receivedAt: "2026-07-25T00:11:00.000Z",
      });
      const afterFollowup = reduceAlertDelivery(
        staleRefire.state,
        nextDelivery,
      );
      expect(afterFollowup.decision).not.toBe("rejected");
    });
  });
});
