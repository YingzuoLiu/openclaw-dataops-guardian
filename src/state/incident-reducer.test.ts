import { describe, expect, it } from "vitest";

import {
  MAX_RECENT_DELIVERY_IDS,
  reduceAlertDelivery,
  type AlertDelivery,
} from "./incident-reducer.js";
import { beginRemediationAttempt } from "./incident-workflow.js";

const startsAt = "2026-07-25T00:00:00.000Z";

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
      reason: "route_to_new_occurrence",
    });
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
      decision: "new_occurrence",
      reason: "previous_attempt_running",
    });
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
      reason: "route_to_new_occurrence",
    });
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
});
