import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  planAlertDeliveryIngestion,
  type DeferredAlertDeliveryCheckpoint,
} from "../ingestion.js";
import { reduceAlertDelivery, type AlertDelivery } from "../../state/incident-reducer.js";
import {
  createIncidentOccurrenceId,
  readIncidentStateV3,
  type IncidentState,
} from "../../state/incident-state.js";
import type { FingerprintRoute } from "./bridge-state.js";
import type { AuditEvent } from "./audit.js";
import { incidentSessionKey } from "./gateway-incident-client.js";
import { BridgeConsistencyError, CheckpointConflictError } from "./errors.js";

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

type ApplyResult = Omit<AlertDispositionResult, "fingerprint" | "deliveryId">;

function assertNever(value: never): never {
  throw new Error(`unhandled alert delivery ingestion plan: ${JSON.stringify(value)}`);
}

/**
 * Describes `route`'s destination session and decodes it, failing closed
 * (`BridgeConsistencyError`) if the session is missing or its value fails
 * `readIncidentStateV3`. A route the bridge itself created must always
 * resolve to a valid session — a miss here means the Gateway session was
 * deleted/reset externally, storage was corrupted, or the route is simply
 * wrong. Silently treating that as "no state, safe to create fresh" would
 * make the bridge fabricate a brand-new `alert_received` occurrence over
 * whatever the destination actually holds, which is exactly the class of
 * bug this type exists to prevent.
 */
async function describeRouteStateStrict(
  deps: ProcessorDeps,
  fingerprint: string,
  route: FingerprintRoute,
): Promise<{ raw: PluginJsonValue; state: IncidentState }> {
  const raw = await deps.gateway.describeIncidentState(route.sessionKey);
  if (raw === undefined) {
    throw new BridgeConsistencyError(
      `fingerprint ${fingerprint} routes to ${route.sessionKey}, but the Gateway session has no incident state`,
    );
  }
  const decoded = readIncidentStateV3(raw);
  if (!decoded.ok) {
    throw new BridgeConsistencyError(
      `fingerprint ${fingerprint} routes to ${route.sessionKey}, but its incident state failed to decode: ${decoded.issues.join("; ")}`,
    );
  }
  return { raw, state: decoded.state };
}

/**
 * Advances the fingerprint's route to `candidate` only if there is no
 * existing route, or the existing route's own occurrence is strictly older
 * (by `startsAt`) than `candidate`. This is the single anti-regression
 * check used everywhere the bridge might move a fingerprint's active
 * occurrence forward — a delayed delivery for an occurrence older than
 * whatever is already active must never move the route backwards, and a
 * checkpoint replay resuming after a crash must still be able to complete
 * a forward move that an earlier, interrupted attempt already started.
 */
async function advanceRouteIfNewer(
  deps: ProcessorDeps,
  fingerprint: string,
  route: FingerprintRoute | undefined,
  candidate: FingerprintRoute,
  candidateStartsAt: string,
): Promise<void> {
  if (!route) {
    deps.bridgeState.commitRouteAndClearCheckpoint(fingerprint, candidate);
    return;
  }
  if (route.occurrenceId === candidate.occurrenceId) {
    return;
  }
  const { state: routeState } = await describeRouteStateStrict(deps, fingerprint, route);
  if (Date.parse(candidateStartsAt) > Date.parse(routeState.startsAt)) {
    deps.bridgeState.commitRouteAndClearCheckpoint(fingerprint, candidate);
  }
  // Otherwise `candidate` is historical relative to the active route: leave
  // the route exactly as it is.
}

/**
 * Applies `delivery` against whatever occurrence it actually belongs to.
 *
 * The delivery's own deterministic occurrence (derived purely from
 * `fingerprint` + `startsAt`) is checked *first*, independently of the
 * fingerprint's current route. This matters for two reasons:
 *
 * - A delivery can target an occurrence that already has real state even
 *   though it is not the fingerprint's currently active occurrence (a
 *   delayed retry for a historical occurrence, or — after a crash between
 *   a checkpoint replay's destination write and its route commit — the
 *   occurrence a checkpoint is *about* to be routed to). Planning against
 *   the *route's* current state in either case would compute a fresh
 *   `alert_received` state and overwrite whatever that occurrence's own
 *   session already holds.
 * - A `resolved` delivery for an occurrence that already exists is not an
 *   orphan, even if it does not match the fingerprint's currently active
 *   occurrence.
 *
 * Only once the delivery's own occurrence is confirmed *not* to exist yet
 * does this fall back to route-based planning via
 * `planAlertDeliveryIngestion`, which is exactly the "is anything currently
 * running that must block this new occurrence" question the reducer
 * already answers correctly for the *active* occurrence.
 */
async function applyDelivery(
  deps: ProcessorDeps,
  delivery: AlertDelivery,
): Promise<ApplyResult> {
  const fingerprint = delivery.fingerprint;
  const ownOccurrenceId = createIncidentOccurrenceId(delivery.fingerprint, delivery.startsAt);
  const ownSessionKey = incidentSessionKey(ownOccurrenceId);
  const route = deps.bridgeState.getRoute(fingerprint);

  if (!route || route.occurrenceId !== ownOccurrenceId) {
    const ownRaw = await deps.gateway.describeIncidentState(ownSessionKey);
    if (ownRaw !== undefined) {
      const ownDecoded = readIncidentStateV3(ownRaw);
      if (!ownDecoded.ok) {
        throw new BridgeConsistencyError(
          `destination session ${ownSessionKey} for fingerprint ${fingerprint} holds invalid incident state: ${ownDecoded.issues.join("; ")}`,
        );
      }
      const result = reduceAlertDelivery(ownDecoded.state, delivery);
      // fingerprint and startsAt are guaranteed to match `ownDecoded.state`
      // by construction (both are exactly what `ownOccurrenceId` was
      // derived from), so the reducer can only report one of
      // updated/duplicate/stale_refire/rejected here — never
      // created/new_occurrence/deferred_new_occurrence/orphan_resolved,
      // all of which require a *different* startsAt than the current state.
      switch (result.decision) {
        case "rejected":
          return { disposition: "rejected", reason: result.reason, occurrenceId: ownOccurrenceId };
        case "updated":
        case "duplicate":
        case "stale_refire": {
          await deps.gateway.persistIncidentState(ownSessionKey, result.state);
          await advanceRouteIfNewer(
            deps,
            fingerprint,
            route,
            { occurrenceId: ownOccurrenceId, sessionKey: ownSessionKey },
            delivery.startsAt,
          );
          return { disposition: result.decision, occurrenceId: ownOccurrenceId };
        }
        default:
          throw new BridgeConsistencyError(
            `reducing a delivery against its own occurrence's state produced an impossible decision: ${result.decision}`,
          );
      }
    }
    // `ownRaw` is undefined: this exact occurrence has never been created.
    // Fall through to route-based planning below.
  }

  const routeRaw = route ? (await describeRouteStateStrict(deps, fingerprint, route)).raw : undefined;
  const plan = planAlertDeliveryIngestion(routeRaw, delivery);

  switch (plan.action) {
    case "persist_occurrence": {
      const sessionKey = route?.sessionKey ?? ownSessionKey;
      await deps.gateway.persistIncidentState(sessionKey, plan.state);
      if (!route) {
        deps.bridgeState.commitRouteAndClearCheckpoint(fingerprint, {
          occurrenceId: plan.occurrenceId,
          sessionKey,
        });
      }
      return { disposition: plan.decision, occurrenceId: plan.occurrenceId };
    }
    case "persist_new_occurrence": {
      // Reached only when the pre-check above confirmed `ownSessionKey` does
      // not exist yet, so `plan.state` (freshly created from `undefined`) is
      // safe to write without clobbering anything.
      await deps.gateway.persistIncidentState(ownSessionKey, plan.state);
      await advanceRouteIfNewer(
        deps,
        fingerprint,
        route,
        { occurrenceId: plan.occurrenceId, sessionKey: ownSessionKey },
        delivery.startsAt,
      );
      return { disposition: "new_occurrence", occurrenceId: plan.occurrenceId };
    }
    case "hold_deferred_delivery": {
      const existing = deps.bridgeState.getCheckpoint(fingerprint);
      if (existing && existing.delivery.deliveryId !== delivery.deliveryId) {
        throw new CheckpointConflictError(
          `fingerprint ${fingerprint} already has a different deferred delivery held (${existing.delivery.deliveryId}); refusing to overwrite it with ${delivery.deliveryId}`,
        );
      }
      deps.bridgeState.setCheckpoint(fingerprint, plan.checkpoint);
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
 * Replays a pending checkpoint's held delivery, if one exists, against
 * whatever occurrence it actually belongs to. Safe to call unconditionally
 * on every delivery and at bridge startup: `applyDelivery` always re-derives
 * the outcome from live Gateway state — including re-checking the delivery's
 * own destination session before ever treating it as a fresh create — so a
 * still-blocked checkpoint is simply rewritten with identical content, and a
 * now-unblocked checkpoint is replayed into its occurrence (creating it, or
 * safely deduping against it if an earlier, interrupted replay already
 * created it) and cleared. See docs/alertmanager-http-bridge.md for the
 * crash-window analysis.
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
