import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  planAlertDeliveryIngestion,
  type DeferredAlertDeliveryCheckpoint,
} from "../ingestion.js";
import type { AlertDelivery } from "../../state/incident-reducer.js";
import type { IncidentState } from "../../state/incident-state.js";
import type { FingerprintRoute } from "./bridge-state.js";
import type { AuditEvent } from "./audit.js";
import { incidentSessionKey } from "./gateway-incident-client.js";

/**
 * Narrow interfaces so the processor depends only on the operations it
 * needs, not on `GatewayIncidentClient`/`BridgeStateStore`/`AuditLog`
 * concretely — this keeps the branching logic here testable with plain
 * in-memory fakes instead of a real Gateway connection or filesystem.
 */
export interface IncidentStateGateway {
  describeIncidentState(sessionKey: string): Promise<PluginJsonValue | undefined>;
  persistIncidentState(sessionKey: string, state: IncidentState): Promise<void>;
}

export interface BridgeRouteStore {
  getRoute(fingerprint: string): FingerprintRoute | undefined;
  getCheckpoint(fingerprint: string): DeferredAlertDeliveryCheckpoint | undefined;
  setRoute(fingerprint: string, route: FingerprintRoute): void;
  setCheckpoint(fingerprint: string, checkpoint: DeferredAlertDeliveryCheckpoint): void;
  commitRouteAndClearCheckpoint(fingerprint: string, route: FingerprintRoute): void;
}

export interface AuditSink {
  record(event: AuditEvent): void;
}

export type AlertDispositionResult = {
  fingerprint: string;
  deliveryId: string;
  disposition:
    | "created"
    | "updated"
    | "duplicate"
    | "stale_refire"
    | "new_occurrence"
    | "deferred_new_occurrence"
    | "orphan_resolved"
    | "rejected";
  occurrenceId?: string;
  reason?: string;
};

export type ProcessorDeps = {
  bridgeState: BridgeRouteStore;
  gateway: IncidentStateGateway;
  audit: AuditSink;
  now: () => string;
};

function assertNever(value: never): never {
  throw new Error(`unhandled alert delivery ingestion plan: ${JSON.stringify(value)}`);
}

/**
 * Applies one canonical delivery against whatever occurrence its
 * fingerprint currently routes to. `current` is always re-read from the
 * Gateway session immediately before planning — the bridge never plans
 * against a locally cached copy of `IncidentState`.
 */
async function applyDelivery(
  deps: ProcessorDeps,
  delivery: AlertDelivery,
): Promise<Omit<AlertDispositionResult, "fingerprint" | "deliveryId">> {
  const route = deps.bridgeState.getRoute(delivery.fingerprint);
  const current = route
    ? await deps.gateway.describeIncidentState(route.sessionKey)
    : undefined;
  const plan = planAlertDeliveryIngestion(current, delivery);

  switch (plan.action) {
    case "persist_occurrence": {
      const sessionKey = route?.sessionKey ?? incidentSessionKey(plan.occurrenceId);
      await deps.gateway.persistIncidentState(sessionKey, plan.state);
      deps.bridgeState.setRoute(delivery.fingerprint, {
        occurrenceId: plan.occurrenceId,
        sessionKey,
      });
      return { disposition: plan.decision, occurrenceId: plan.occurrenceId };
    }
    case "persist_new_occurrence": {
      const sessionKey = incidentSessionKey(plan.occurrenceId);
      await deps.gateway.persistIncidentState(sessionKey, plan.state);
      // The destination occurrence and the fingerprint's route must both be
      // durable before any checkpoint that fed this delivery is cleared;
      // `commitRouteAndClearCheckpoint` performs that as one flush so a
      // crash right after this line can never observe a moved route with a
      // stale checkpoint still pointing at the old occurrence.
      deps.bridgeState.commitRouteAndClearCheckpoint(delivery.fingerprint, {
        occurrenceId: plan.occurrenceId,
        sessionKey,
      });
      return { disposition: "new_occurrence", occurrenceId: plan.occurrenceId };
    }
    case "hold_deferred_delivery": {
      deps.bridgeState.setCheckpoint(delivery.fingerprint, plan.checkpoint);
      return {
        disposition: "deferred_new_occurrence",
        occurrenceId: plan.currentState.occurrenceId,
      };
    }
    case "ignore_orphan_resolved":
      return {
        disposition: "orphan_resolved",
        reason: plan.reason,
        ...(plan.currentState ? { occurrenceId: plan.currentState.occurrenceId } : {}),
      };
    case "reject_delivery":
      return {
        disposition: "rejected",
        reason: plan.reason,
        ...(plan.currentState ? { occurrenceId: plan.currentState.occurrenceId } : {}),
      };
    default:
      return assertNever(plan);
  }
}

/**
 * Replays a pending checkpoint's held delivery, if one exists, against the
 * fingerprint's current route. Safe to call unconditionally on every
 * delivery and at bridge startup: `applyDelivery` re-derives the outcome
 * from live Gateway state, so a still-blocked checkpoint is simply
 * rewritten with identical content, and a now-unblocked checkpoint is
 * replayed into its new occurrence and cleared. See
 * docs/alertmanager-http-bridge.md for the crash-window analysis.
 */
export async function drainPendingCheckpoint(
  deps: ProcessorDeps,
  fingerprint: string,
): Promise<void> {
  const checkpoint = deps.bridgeState.getCheckpoint(fingerprint);
  if (!checkpoint) {
    return;
  }
  const delivery = checkpoint.delivery;
  const result = await applyDelivery(deps, delivery);
  deps.audit.record({
    kind: "alert_processed",
    at: deps.now(),
    fingerprint,
    deliveryId: delivery.deliveryId,
    alertStatus: delivery.alertStatus,
    startsAt: delivery.startsAt,
    endsAt: delivery.endsAt,
    disposition: result.disposition,
    ...(result.occurrenceId ? { occurrenceId: result.occurrenceId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    replay: true,
  });
}

/**
 * Processes one canonical alert delivery end to end: drains any pending
 * checkpoint for its fingerprint first, then applies the delivery itself,
 * auditing both. Callers must invoke this only while holding the
 * fingerprint's `FingerprintLock` slot and must treat a thrown error as "not
 * durable" — no HTTP 2xx may be sent for this alert.
 */
export async function processCanonicalAlertDelivery(
  deps: ProcessorDeps,
  delivery: AlertDelivery,
): Promise<AlertDispositionResult> {
  await drainPendingCheckpoint(deps, delivery.fingerprint);
  const result = await applyDelivery(deps, delivery);
  deps.audit.record({
    kind: "alert_processed",
    at: deps.now(),
    fingerprint: delivery.fingerprint,
    deliveryId: delivery.deliveryId,
    alertStatus: delivery.alertStatus,
    startsAt: delivery.startsAt,
    endsAt: delivery.endsAt,
    disposition: result.disposition,
    ...(result.occurrenceId ? { occurrenceId: result.occurrenceId } : {}),
    ...(result.reason ? { reason: result.reason } : {}),
    replay: false,
  });
  return {
    fingerprint: delivery.fingerprint,
    deliveryId: delivery.deliveryId,
    ...result,
  };
}
