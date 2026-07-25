import { describe, expect, it } from "vitest";

import {
  MAX_RECENT_DELIVERY_IDS,
  reduceAlertDelivery,
  type AlertDelivery,
} from "./incident-reducer.js";

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
      state: {
        startsAt: "2026-07-25T01:00:00.000Z",
        deliveryCount: 1,
      },
    });
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
