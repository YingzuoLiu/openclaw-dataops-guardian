import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";

import type { AlertDelivery } from "../../state/incident-reducer.js";
import { createIncidentOccurrenceId, type IncidentState } from "../../state/incident-state.js";
import type { DeferredAlertDeliveryCheckpoint } from "../ingestion.js";
import type { AuditEvent } from "./audit.js";
import type { FingerprintRoute } from "./bridge-state.js";
import { DeliveryOrderingError } from "./errors.js";
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

  it("does not clobber destination state that was advanced after an earlier, interrupted replay", async () => {
    // Regression test for the crash window where a checkpoint replay's
    // destination write succeeds but the process is killed before the
    // route/checkpoint commit. If some other workflow (an operator, Lobster,
    // an Agent) then advances that newly created destination session before
    // the bridge gets a chance to retry, a later drain must not overwrite
    // that progress with a freshly-created `alert_received` state.
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
    await processCanonicalAlertDelivery(deps, heldDelivery);
    expect(bridgeState.getCheckpoint("fingerprint-1")).toBeDefined();
    const heldOccurrenceId = createIncidentOccurrenceId("fingerprint-1", heldDelivery.startsAt);
    const heldSessionKey = incidentSessionKey(heldOccurrenceId);

    // Settle the blocking attempt (out of scope for this bridge).
    gateway.sessions.set(route.sessionKey, {
      ...running,
      remediationAttempts: [
        { ...running.remediationAttempts[0]!, status: "succeeded", finishedAt: "2026-08-01T00:04:00.000Z" },
      ],
      stage: "recovery_check",
      updatedAt: "2026-08-01T00:04:00.000Z",
    });

    // Simulate an earlier, interrupted replay: the destination session
    // already exists (with the held delivery recorded) and has since been
    // advanced further, but the bridge's route/checkpoint were never
    // committed (as if the process crashed right after the write below).
    gateway.sessions.set(heldSessionKey, {
      schemaVersion: 3,
      alertId: heldDelivery.alertId,
      fingerprint: heldDelivery.fingerprint,
      occurrenceId: heldOccurrenceId,
      alertStatus: "firing",
      startsAt: heldDelivery.startsAt,
      endsAt: null,
      lastReceivedAt: heldDelivery.receivedAt,
      deliveryCount: 1,
      nonDuplicateDeliveryCount: 1,
      recentDeliveryIds: [heldDelivery.deliveryId],
      stage: "evidence_collection",
      evidence: [
        {
          source: "external_workflow",
          observedAt: "2026-08-02T00:05:00.000Z",
          summary: "Advanced externally between the crash-vulnerable write and recovery.",
        },
      ],
      proposedAction: null,
      approvalStatus: "not_requested",
      remediationAttempts: [],
      evidenceValidation: { status: "not_checked", checkedAt: null, issues: [] },
      updatedAt: "2026-08-02T00:05:00.000Z",
    });

    await drainPendingCheckpoint(deps, "fingerprint-1");

    expect(bridgeState.getCheckpoint("fingerprint-1")).toBeUndefined();
    const newRoute = bridgeState.getRoute("fingerprint-1")!;
    expect(newRoute.occurrenceId).toBe(heldOccurrenceId);
    const finalState = gateway.sessions.get(heldSessionKey)!;
    expect(finalState.stage).toBe("evidence_collection");
    expect(finalState.evidence).toHaveLength(1);
    expect(finalState.evidence[0]!.source).toBe("external_workflow");
    // The resend must still be recognized as the same delivery, not
    // double-counted.
    expect(finalState.recentDeliveryIds).toEqual([heldDelivery.deliveryId]);
    expect(created.occurrenceId).not.toBe(newRoute.occurrenceId);
  });
});

describe("recovery from a transient Gateway persistence failure", () => {
  // Platform-independent equivalent of the HTTP-level "Gateway goes down,
  // then comes back" scenario: exercised here as a synchronous, in-process
  // Gateway RPC failure/recovery rather than an actual killed-and-restarted
  // process, so it runs identically on every OS the test suite runs on
  // (unlike the full `alertmanager:http-bridge-proof`, which spawns real
  // child processes and is sensitive to how quickly the OS reports a
  // dropped/restored TCP connection).
  it("does not lose or corrupt a held checkpoint across a failed drain, and recovers once the Gateway is reachable again", async () => {
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
    const checkpointBeforeFailure = bridgeState.getCheckpoint("fingerprint-1");
    expect(checkpointBeforeFailure).toBeDefined();

    // Settle the blocking attempt (as restart reconciliation would, out of
    // this bridge's scope) so the next drain attempt is otherwise eligible
    // to replay — then make the Gateway unreachable for the replay's own
    // destination session, simulating the Gateway being down mid-drain.
    gateway.sessions.set(route.sessionKey, {
      ...running,
      remediationAttempts: [
        { ...running.remediationAttempts[0]!, status: "succeeded", finishedAt: "2026-08-01T00:04:00.000Z" },
      ],
      stage: "recovery_check",
      updatedAt: "2026-08-01T00:04:00.000Z",
    });
    const heldOccurrenceId = createIncidentOccurrenceId("fingerprint-1", "2026-08-02T00:00:00.000Z");
    gateway.failingSessionKeys.add(incidentSessionKey(heldOccurrenceId));

    await expect(drainPendingCheckpoint(deps, "fingerprint-1")).rejects.toThrow();

    // The failed drain must not have lost, cleared, or altered the
    // checkpoint, nor moved the route — exactly the property the bridge's
    // `persistence_unavailable` HTTP path (`server.ts`) depends on to be
    // safe to retry.
    expect(bridgeState.getCheckpoint("fingerprint-1")).toEqual(checkpointBeforeFailure);
    expect(bridgeState.getRoute("fingerprint-1")).toEqual(route);

    // The transient condition clears (the Gateway becomes reachable again,
    // exactly as it does once `start_gateway` brings a fresh process up in
    // the HTTP-level proof) — a retry of the exact same drain must now
    // succeed rather than being permanently stuck.
    gateway.failingSessionKeys.delete(incidentSessionKey(heldOccurrenceId));

    await drainPendingCheckpoint(deps, "fingerprint-1");

    expect(bridgeState.getCheckpoint("fingerprint-1")).toBeUndefined();
    const newRoute = bridgeState.getRoute("fingerprint-1")!;
    expect(newRoute.occurrenceId).toBe(heldOccurrenceId);
    expect(newRoute.occurrenceId).not.toBe(created.occurrenceId);
    const replayedState = gateway.sessions.get(newRoute.sessionKey);
    // Recorded exactly once: the failed attempt above must not have
    // double-applied the delivery before throwing.
    expect(replayedState?.recentDeliveryIds.filter((id) => id === "delivery-2")).toEqual(["delivery-2"]);
  });
});

describe("checkpoint conflict", () => {
  it("preserves an already-held deferred delivery and rejects a conflicting one", async () => {
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

    const firstHeld = delivery({
      startsAt: "2026-08-02T00:00:00.000Z",
      receivedAt: "2026-08-02T00:00:01.000Z",
      deliveryId: "delivery-2",
    });
    const firstResult = await processCanonicalAlertDelivery(deps, firstHeld);
    expect(firstResult.disposition).toBe("deferred_new_occurrence");
    const checkpointAfterFirst = bridgeState.getCheckpoint("fingerprint-1");
    expect(checkpointAfterFirst?.delivery.deliveryId).toBe("delivery-2");

    const secondHeld = delivery({
      startsAt: "2026-08-03T00:00:00.000Z",
      receivedAt: "2026-08-03T00:00:01.000Z",
      deliveryId: "delivery-3",
    });
    await expect(processCanonicalAlertDelivery(deps, secondHeld)).rejects.toThrow(
      /different deferred delivery held/,
    );

    // The original held delivery must be untouched.
    const checkpointAfterConflict = bridgeState.getCheckpoint("fingerprint-1");
    expect(checkpointAfterConflict?.delivery.deliveryId).toBe("delivery-2");
    // The conflicting delivery's own occurrence must never have been created.
    const secondOccurrenceId = createIncidentOccurrenceId("fingerprint-1", secondHeld.startsAt);
    expect(gateway.sessions.has(incidentSessionKey(secondOccurrenceId))).toBe(false);
  });

  it("idempotently re-holds the same deferred delivery without conflict", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    await processCanonicalAlertDelivery(deps, delivery());
    const route = bridgeState.getRoute("fingerprint-1")!;
    gateway.sessions.set(route.sessionKey, {
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
    });

    const held = delivery({
      startsAt: "2026-08-02T00:00:00.000Z",
      receivedAt: "2026-08-02T00:00:01.000Z",
      deliveryId: "delivery-2",
    });
    await processCanonicalAlertDelivery(deps, held);
    // Re-sending the exact same held delivery (e.g. Alertmanager's
    // repeat_interval) must not be treated as a conflict with itself.
    const second = await processCanonicalAlertDelivery(deps, held);
    expect(second.disposition).toBe("deferred_new_occurrence");
    expect(bridgeState.getCheckpoint("fingerprint-1")?.delivery.deliveryId).toBe("delivery-2");
  });
});

describe("route regression protection", () => {
  it("never moves the active route backward for a delayed, older delivery", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const fingerprint = "fingerprint-1";

    const firingA = delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a" });
    const a = await processCanonicalAlertDelivery(deps, firingA);
    expect(a.disposition).toBe("created");

    const firingB = delivery({
      startsAt: "2026-08-02T00:00:00.000Z",
      receivedAt: "2026-08-02T00:00:01.000Z",
      deliveryId: "delivery-b",
    });
    const b = await processCanonicalAlertDelivery(deps, firingB);
    expect(b.disposition).toBe("new_occurrence");
    const routeAfterB = bridgeState.getRoute(fingerprint)!;
    expect(routeAfterB.occurrenceId).toBe(b.occurrenceId);
    const bStateBefore = gateway.sessions.get(routeAfterB.sessionKey)!;

    // A delayed retry of A's original firing delivery arrives after B is
    // already active.
    const delayedA = delivery({
      startsAt: "2026-08-01T00:00:00.000Z",
      receivedAt: "2026-08-03T00:00:00.000Z",
      deliveryId: "delivery-a",
    });
    const delayedAResult = await processCanonicalAlertDelivery(deps, delayedA);
    expect(delayedAResult.disposition).toBe("duplicate");
    expect(delayedAResult.occurrenceId).toBe(a.occurrenceId);
    expect(bridgeState.getRoute(fingerprint)).toEqual(routeAfterB);
    expect(gateway.sessions.get(routeAfterB.sessionKey)).toEqual(bStateBefore);

    // A delayed resolution for A arrives even later; it must update A's own
    // session, not be treated as orphaned, and still must not move the route.
    const delayedAResolved = delivery({
      alertStatus: "resolved",
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-01T00:10:00.000Z",
      receivedAt: "2026-08-04T00:00:00.000Z",
      deliveryId: "delivery-a-resolved",
    });
    const resolvedResult = await processCanonicalAlertDelivery(deps, delayedAResolved);
    expect(resolvedResult.disposition).toBe("updated");
    expect(resolvedResult.occurrenceId).toBe(a.occurrenceId);
    expect(bridgeState.getRoute(fingerprint)).toEqual(routeAfterB);
    expect(gateway.sessions.get(routeAfterB.sessionKey)).toEqual(bStateBefore);

    const aFinal = gateway.sessions.get(incidentSessionKey(a.occurrenceId!))!;
    expect(aFinal.alertStatus).toBe("resolved");
  });
});

describe("consistency fail-closed checks", () => {
  it("throws when the route points at a session the Gateway no longer has", async () => {
    const { deps, bridgeState } = makeDeps();
    bridgeState.setRoute("fingerprint-1", {
      occurrenceId: "missing-occurrence",
      sessionKey: incidentSessionKey("missing-occurrence"),
    });

    await expect(processCanonicalAlertDelivery(deps, delivery())).rejects.toThrow(
      /has no incident state/,
    );
  });

  it("throws when the route's destination state fails to decode", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const occurrenceId = "corrupt-occurrence";
    const sessionKey = incidentSessionKey(occurrenceId);
    bridgeState.setRoute("fingerprint-1", { occurrenceId, sessionKey });
    gateway.sessions.set(sessionKey, { not: "a valid incident state" } as unknown as IncidentState);

    await expect(processCanonicalAlertDelivery(deps, delivery())).rejects.toThrow(
      /failed to decode/,
    );
  });

  it("throws when the route's destination session holds a different fingerprint's state", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    const a = await processCanonicalAlertDelivery(
      deps,
      delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a" }),
    );
    const other = await processCanonicalAlertDelivery(
      deps,
      delivery({
        fingerprint: "fingerprint-2",
        startsAt: "2026-08-05T00:00:00.000Z",
        receivedAt: "2026-08-05T00:01:00.000Z",
        deliveryId: "delivery-other",
      }),
    );
    const routeA = bridgeState.getRoute("fingerprint-1")!;
    const otherSessionKey = incidentSessionKey(other.occurrenceId!);
    // Corrupt fingerprint-1's route session to (wrongly) hold
    // fingerprint-2's real, internally self-consistent state.
    gateway.sessions.set(routeA.sessionKey, gateway.sessions.get(otherSessionKey)!);
    expect(a.occurrenceId).not.toBe(other.occurrenceId);

    await expect(
      processCanonicalAlertDelivery(
        deps,
        delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a-dup" }),
      ),
    ).rejects.toThrow(/belongs to fingerprint/);
  });

  it("throws when the route's destination session holds a different occurrenceId's state", async () => {
    const { deps, gateway, bridgeState } = makeDeps();
    await processCanonicalAlertDelivery(
      deps,
      delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a" }),
    );
    const routeA = bridgeState.getRoute("fingerprint-1")!;
    const otherOccurrenceId = createIncidentOccurrenceId("fingerprint-1", "2026-09-01T00:00:00.000Z");
    const swapped: IncidentState = {
      ...gateway.sessions.get(routeA.sessionKey)!,
      occurrenceId: otherOccurrenceId,
      startsAt: "2026-09-01T00:00:00.000Z",
      lastReceivedAt: "2026-09-01T00:01:00.000Z",
      updatedAt: "2026-09-01T00:01:00.000Z",
    };
    // Same fingerprint, self-consistent, but not the occurrence the route
    // claims to point at.
    gateway.sessions.set(routeA.sessionKey, swapped);

    await expect(
      processCanonicalAlertDelivery(
        deps,
        delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a-dup" }),
      ),
    ).rejects.toThrow(/occurrenceId/);
  });

  it("throws when a delivery's own destination session holds a different fingerprint's state", async () => {
    const { deps, gateway } = makeDeps();
    await processCanonicalAlertDelivery(
      deps,
      delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a" }),
    );
    const other = await processCanonicalAlertDelivery(
      deps,
      delivery({
        fingerprint: "fingerprint-2",
        startsAt: "2026-08-05T00:00:00.000Z",
        receivedAt: "2026-08-05T00:01:00.000Z",
        deliveryId: "delivery-other",
      }),
    );
    const otherRealState = gateway.sessions.get(incidentSessionKey(other.occurrenceId!))!;

    // fingerprint-1's own deterministic session for a brand new startsAt now
    // (wrongly) holds fingerprint-2's real, self-consistent state.
    const bStartsAt = "2026-08-06T00:00:00.000Z";
    const bOccurrenceId = createIncidentOccurrenceId("fingerprint-1", bStartsAt);
    gateway.sessions.set(incidentSessionKey(bOccurrenceId), otherRealState);

    await expect(
      processCanonicalAlertDelivery(deps, delivery({ startsAt: bStartsAt, deliveryId: "delivery-b" })),
    ).rejects.toThrow(/fingerprint/);
  });

  it("throws when a delivery's own destination session holds a different occurrenceId's state", async () => {
    const { deps, gateway } = makeDeps();
    await processCanonicalAlertDelivery(
      deps,
      delivery({ startsAt: "2026-08-01T00:00:00.000Z", deliveryId: "delivery-a" }),
    );
    const c = await processCanonicalAlertDelivery(
      deps,
      delivery({
        startsAt: "2026-08-10T00:00:00.000Z",
        receivedAt: "2026-08-10T00:01:00.000Z",
        deliveryId: "delivery-c",
      }),
    );
    const cRealState = gateway.sessions.get(incidentSessionKey(c.occurrenceId!))!;

    const bStartsAt = "2026-08-06T00:00:00.000Z";
    const bOccurrenceId = createIncidentOccurrenceId("fingerprint-1", bStartsAt);
    // Same fingerprint, self-consistent, but planted under a session key
    // that deterministically belongs to a *different* occurrenceId.
    gateway.sessions.set(incidentSessionKey(bOccurrenceId), cRealState);

    await expect(
      processCanonicalAlertDelivery(deps, delivery({ startsAt: bStartsAt, deliveryId: "delivery-b" })),
    ).rejects.toThrow(/occurrenceId/);
  });
});

describe("delivery ordering (received_at_regression)", () => {
  // `receivedAt` is stamped once per HTTP attempt, before the per-fingerprint
  // lock is acquired (see server.ts), so two concurrent requests for the
  // same fingerprint can reach the reducer out of receivedAt order. A
  // resulting `received_at_regression` must fail closed (throw) rather than
  // ride inside an ordinary 2xx/207 "rejected" result, which would let
  // Alertmanager treat a delivery that merely lost a benign race as
  // permanently, successfully delivered.
  it("throws DeliveryOrderingError instead of returning an ordinary rejected disposition (same occurrence)", async () => {
    const { deps } = makeDeps();
    await processCanonicalAlertDelivery(
      deps,
      delivery({ receivedAt: "2026-08-01T00:02:00.000Z", deliveryId: "delivery-1" }),
    );
    // A second delivery for the same occurrence whose receivedAt is *older*
    // than what was just applied simulates the race directly.
    await expect(
      processCanonicalAlertDelivery(
        deps,
        delivery({ deliveryId: "delivery-late", receivedAt: "2026-08-01T00:00:30.000Z" }),
      ),
    ).rejects.toThrow(DeliveryOrderingError);
  });

  it("throws DeliveryOrderingError for a regression against a historical (non-active) occurrence too", async () => {
    const { deps, bridgeState } = makeDeps();
    await processCanonicalAlertDelivery(
      deps,
      delivery({
        startsAt: "2026-08-01T00:00:00.000Z",
        receivedAt: "2026-08-01T00:05:00.000Z",
        deliveryId: "delivery-a",
      }),
    );
    // B firing makes A historical (route moves to B; A is untouched but no
    // longer active).
    await processCanonicalAlertDelivery(
      deps,
      delivery({
        startsAt: "2026-08-02T00:00:00.000Z",
        receivedAt: "2026-08-02T00:00:01.000Z",
        deliveryId: "delivery-b",
      }),
    );
    expect(bridgeState.getRoute("fingerprint-1")?.occurrenceId).not.toBe(
      createIncidentOccurrenceId("fingerprint-1", "2026-08-01T00:00:00.000Z"),
    );

    // A further delayed delivery for A, older than A's own lastReceivedAt,
    // is handled by the own-occurrence (Phase 1) path.
    await expect(
      processCanonicalAlertDelivery(
        deps,
        delivery({
          startsAt: "2026-08-01T00:00:00.000Z",
          receivedAt: "2026-08-01T00:01:00.000Z",
          deliveryId: "delivery-a-late",
        }),
      ),
    ).rejects.toThrow(DeliveryOrderingError);
  });
});
