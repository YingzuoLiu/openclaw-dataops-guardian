import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";

import type { AlertDelivery } from "../../state/incident-reducer.js";
import { createIncidentOccurrenceId, type IncidentState } from "../../state/incident-state.js";
import type { DeferredAlertDeliveryCheckpoint } from "../ingestion.js";
import type { AuditEvent } from "./audit.js";
import type { FingerprintRoute } from "./bridge-state.js";
import { incidentSessionKey } from "./gateway-incident-client.js";
import {
  drainPendingCheckpoint,
  processCanonicalAlertDelivery,
  type AuditSink,
  type BridgeRouteStore,
  type IncidentStateGateway,
  type ProcessorDeps,
} from "./processor.js";

class FakeGateway implements IncidentStateGateway {
  readonly sessions = new Map<string, IncidentState>();
  readonly failingSessionKeys = new Set<string>();

  async describeIncidentState(sessionKey: string): Promise<PluginJsonValue | undefined> {
    const state = this.sessions.get(sessionKey);
    return state === undefined ? undefined : (state as unknown as PluginJsonValue);
  }

  async persistIncidentState(sessionKey: string, state: IncidentState): Promise<void> {
    if (this.failingSessionKeys.has(sessionKey)) {
      throw new Error(`simulated gateway failure for ${sessionKey}`);
    }
    this.sessions.set(sessionKey, state);
  }
}

class FakeBridgeStore implements BridgeRouteStore {
  private readonly routes = new Map<string, FingerprintRoute>();
  private readonly checkpoints = new Map<string, DeferredAlertDeliveryCheckpoint>();

  getRoute(fingerprint: string): FingerprintRoute | undefined {
    return this.routes.get(fingerprint);
  }

  getCheckpoint(fingerprint: string): DeferredAlertDeliveryCheckpoint | undefined {
    return this.checkpoints.get(fingerprint);
  }

  setRoute(fingerprint: string, route: FingerprintRoute): void {
    this.routes.set(fingerprint, route);
  }

  setCheckpoint(fingerprint: string, checkpoint: DeferredAlertDeliveryCheckpoint): void {
    this.checkpoints.set(fingerprint, checkpoint);
  }

  commitRouteAndClearCheckpoint(fingerprint: string, route: FingerprintRoute): void {
    this.routes.set(fingerprint, route);
    this.checkpoints.delete(fingerprint);
  }
}

class FakeAudit implements AuditSink {
  readonly events: AuditEvent[] = [];
  record(event: AuditEvent): void {
    this.events.push(event);
  }
}

function delivery(overrides: Partial<AlertDelivery> = {}): AlertDelivery {
  return {
    alertId: "PaymentSuccessRateLow",
    fingerprint: "fingerprint-1",
    alertStatus: "firing",
    startsAt: "2026-08-01T00:00:00.000Z",
    endsAt: null,
    receivedAt: "2026-08-01T00:01:00.000Z",
    deliveryId: "delivery-1",
    ...overrides,
  };
}

function makeDeps(): { deps: ProcessorDeps; gateway: FakeGateway; bridgeState: FakeBridgeStore; audit: FakeAudit } {
  const gateway = new FakeGateway();
  const bridgeState = new FakeBridgeStore();
  const audit = new FakeAudit();
  return {
    deps: { gateway, bridgeState, audit, now: () => "2026-08-01T00:02:00.000Z" },
    gateway,
    bridgeState,
    audit,
  };
}

describe("processCanonicalAlertDelivery", () => {
  it("creates a brand new occurrence and routes the fingerprint to it", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const result = await processCanonicalAlertDelivery(deps, delivery());

    expect(result.disposition).toBe("created");
    const expectedOccurrenceId = createIncidentOccurrenceId(
      "fingerprint-1",
      "2026-08-01T00:00:00.000Z",
    );
    expect(result.occurrenceId).toBe(expectedOccurrenceId);
    const route = bridgeState.getRoute("fingerprint-1");
    expect(route?.occurrenceId).toBe(expectedOccurrenceId);
    expect(gateway.sessions.get(route!.sessionKey)?.occurrenceId).toBe(expectedOccurrenceId);
  });

  it("deduplicates a repeated delivery id without changing the occurrence", async () => {
    const { deps } = makeDeps();
    await processCanonicalAlertDelivery(deps, delivery());
    const second = await processCanonicalAlertDelivery(
      deps,
      delivery({ receivedAt: "2026-08-01T00:02:00.000Z" }),
    );
    expect(second.disposition).toBe("duplicate");
  });

  it("routes a new startsAt to an independent occurrence when nothing is running", async () => {
    const { deps } = makeDeps();
    const first = await processCanonicalAlertDelivery(deps, delivery());
    const second = await processCanonicalAlertDelivery(
      deps,
      delivery({
        startsAt: "2026-08-02T00:00:00.000Z",
        receivedAt: "2026-08-02T00:00:01.000Z",
        deliveryId: "delivery-2",
      }),
    );
    expect(second.disposition).toBe("new_occurrence");
    expect(second.occurrenceId).not.toBe(first.occurrenceId);
  });

  it("holds a deferred delivery as a checkpoint without touching the blocking occurrence", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const created = await processCanonicalAlertDelivery(deps, delivery());
    const route = bridgeState.getRoute("fingerprint-1")!;

    const running: IncidentState = {
      ...gateway.sessions.get(route.sessionKey)!,
      stage: "remediation",
      approvalStatus: "approved",
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          target: { kind: "synthetic" },
          status: "running",
          startedAt: "2026-08-01T00:03:00.000Z",
          finishedAt: null,
          error: null,
        },
      ],
      updatedAt: "2026-08-01T00:03:00.000Z",
    };
    gateway.sessions.set(route.sessionKey, running);

    const heldDelivery = delivery({
      startsAt: "2026-08-02T00:00:00.000Z",
      receivedAt: "2026-08-02T00:00:01.000Z",
      deliveryId: "delivery-2",
    });
    const held = await processCanonicalAlertDelivery(deps, heldDelivery);

    expect(held.disposition).toBe("deferred_new_occurrence");
    expect(held.occurrenceId).toBe(created.occurrenceId);
    const checkpoint = bridgeState.getCheckpoint("fingerprint-1");
    expect(checkpoint?.delivery.deliveryId).toBe("delivery-2");
    // The blocking occurrence's session must be untouched by the hold.
    expect(gateway.sessions.get(route.sessionKey)).toEqual(running);
  });

  it("throws and leaves no route committed when the gateway write fails", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const occurrenceId = createIncidentOccurrenceId(
      "fingerprint-1",
      "2026-08-01T00:00:00.000Z",
    );
    gateway.failingSessionKeys.add(incidentSessionKey(occurrenceId));

    await expect(processCanonicalAlertDelivery(deps, delivery())).rejects.toThrow();
    expect(bridgeState.getRoute("fingerprint-1")).toBeUndefined();
  });

  it("does not persist state for an orphan-resolved delivery", async () => {
    const { deps, bridgeState } = makeDeps();
    const result = await processCanonicalAlertDelivery(
      deps,
      delivery({
        alertStatus: "resolved",
        endsAt: "2026-08-01T00:05:00.000Z",
      }),
    );
    expect(result.disposition).toBe("orphan_resolved");
    expect(bridgeState.getRoute("fingerprint-1")).toBeUndefined();
  });
});

describe("drainPendingCheckpoint", () => {
  it("replays a held delivery into a new occurrence once the block clears", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const created = await processCanonicalAlertDelivery(deps, delivery());
    const route = bridgeState.getRoute("fingerprint-1")!;

    const running: IncidentState = {
      ...gateway.sessions.get(route.sessionKey)!,
      stage: "remediation",
      approvalStatus: "approved",
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          target: { kind: "synthetic" },
          status: "running",
          startedAt: "2026-08-01T00:03:00.000Z",
          finishedAt: null,
          error: null,
        },
      ],
      updatedAt: "2026-08-01T00:03:00.000Z",
    };
    gateway.sessions.set(route.sessionKey, running);

    await processCanonicalAlertDelivery(
      deps,
      delivery({
        startsAt: "2026-08-02T00:00:00.000Z",
        receivedAt: "2026-08-02T00:00:01.000Z",
        deliveryId: "delivery-2",
      }),
    );
    expect(bridgeState.getCheckpoint("fingerprint-1")).toBeDefined();

    // Simulate the running attempt being settled by restart reconciliation
    // (out of this bridge's scope) before the next drain attempt.
    gateway.sessions.set(route.sessionKey, {
      ...running,
      remediationAttempts: [
        {
          ...running.remediationAttempts[0]!,
          status: "succeeded",
          finishedAt: "2026-08-01T00:04:00.000Z",
        },
      ],
      stage: "recovery_check",
      updatedAt: "2026-08-01T00:04:00.000Z",
    });

    await drainPendingCheckpoint(deps, "fingerprint-1");

    expect(bridgeState.getCheckpoint("fingerprint-1")).toBeUndefined();
    const newRoute = bridgeState.getRoute("fingerprint-1")!;
    expect(newRoute.occurrenceId).not.toBe(created.occurrenceId);
    expect(gateway.sessions.get(newRoute.sessionKey)?.recentDeliveryIds).toContain("delivery-2");
  });

  it("leaves the checkpoint in place while the blocking attempt is still running", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    await processCanonicalAlertDelivery(deps, delivery());
    const route = bridgeState.getRoute("fingerprint-1")!;
    const running: IncidentState = {
      ...gateway.sessions.get(route.sessionKey)!,
      stage: "remediation",
      approvalStatus: "approved",
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          target: { kind: "synthetic" },
          status: "running",
          startedAt: "2026-08-01T00:03:00.000Z",
          finishedAt: null,
          error: null,
        },
      ],
      updatedAt: "2026-08-01T00:03:00.000Z",
    };
    gateway.sessions.set(route.sessionKey, running);
    await processCanonicalAlertDelivery(
      deps,
      delivery({
        startsAt: "2026-08-02T00:00:00.000Z",
        receivedAt: "2026-08-02T00:00:01.000Z",
        deliveryId: "delivery-2",
      }),
    );

    await drainPendingCheckpoint(deps, "fingerprint-1");

    expect(bridgeState.getCheckpoint("fingerprint-1")).toBeDefined();
    expect(bridgeState.getRoute("fingerprint-1")).toEqual(route);
  });

  it("is a no-op when there is no pending checkpoint", async () => {
    const { deps, bridgeState } = makeDeps();
    await expect(drainPendingCheckpoint(deps, "unknown-fingerprint")).resolves.toBeUndefined();
    expect(bridgeState.getCheckpoint("unknown-fingerprint")).toBeUndefined();
  });
});
