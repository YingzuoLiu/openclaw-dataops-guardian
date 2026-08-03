import {
  canonicalTimestamp,
  computeDeferredAlertDeliveryCheckpointId,
  createAlertmanagerDeliveryId,
  type DeferredAlertDeliveryCheckpoint,
} from "../ingestion.js";
import { reduceAlertDelivery, type AlertDelivery } from "../../state/incident-reducer.js";
import { incidentSessionKey } from "./gateway-incident-client.js";
import {
  readJsonFileOrUndefined,
  writeJsonFileDurable,
} from "./json-store.js";

export const BRIDGE_STATE_SCHEMA_VERSION = 1;

/**
 * Per-fingerprint pointer to the occurrence/session currently routed for
 * that fingerprint. This is a cache of *where* the fact lives, never a copy
 * of the fact itself: `IncidentState` stays sourced from the Gateway session
 * on every read.
 */
export type FingerprintRoute = {
  occurrenceId: string;
  sessionKey: string;
};

export type BridgeState = {
  schemaVersion: 1;
  routes: Record<string, FingerprintRoute>;
  checkpoints: Record<string, DeferredAlertDeliveryCheckpoint>;
};

function emptyState(): BridgeState {
  return { schemaVersion: BRIDGE_STATE_SCHEMA_VERSION, routes: {}, checkpoints: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A route's `sessionKey` is never stored independently of `occurrenceId` —
 * it must always equal `incidentSessionKey(occurrenceId)`. Validating that
 * here catches corruption or hand-edited state before it can send the
 * bridge describing/patching the wrong Gateway session.
 */
function isFingerprintRoute(value: unknown): value is FingerprintRoute {
  return (
    isRecord(value) &&
    isNonEmptyString(value.occurrenceId) &&
    isNonEmptyString(value.sessionKey) &&
    value.sessionKey === incidentSessionKey(value.occurrenceId)
  );
}

/**
 * Requires the value to be *exactly* the normalized ISO string
 * `canonicalTimestamp` (ingestion.ts) itself would produce — not merely
 * something `Date.parse` accepts. `createAlertmanagerDeliveryId` hashes the
 * raw string, so a persisted timestamp that is valid-but-not-canonical
 * (e.g. `+00:00` instead of `Z`) would silently compute a different
 * deliveryId than `canonicalizeAlertmanagerWebhook` ever would have — this
 * is what makes the deliveryId recomputation below meaningful rather than
 * incidentally passable by a differently-formatted-but-equivalent string.
 */
function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && canonicalTimestamp(value) === value;
}

/**
 * Structural shape and canonical-timestamp form first (so
 * `reduceAlertDelivery` below never sees a malformed object, and so the
 * deliveryId recomputation in `isDeferredCheckpoint` is meaningful), then
 * the delivery's own semantic contract — `receivedAt >= startsAt`, `firing`
 * requiring `endsAt: null`, `resolved` requiring a valid `endsAt >=
 * startsAt` — is enforced by reusing `reduceAlertDelivery`'s own validation
 * instead of re-implementing it here. `reduceAlertDelivery(undefined,
 * value)` can only report `rejected` because of that delivery-level check
 * (with `current` undefined, nothing else can reject it), so any
 * non-`rejected` decision means the delivery passes the exact same
 * contract the reducer itself enforces at runtime — avoiding a second,
 * driftable copy of those rules.
 */
function isValidAlertDelivery(value: unknown): value is AlertDelivery {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.alertId) ||
    !isNonEmptyString(value.fingerprint) ||
    !new Set(["firing", "resolved"]).has(value.alertStatus as string) ||
    !isCanonicalTimestamp(value.startsAt) ||
    !(value.endsAt === null || isCanonicalTimestamp(value.endsAt)) ||
    !isCanonicalTimestamp(value.receivedAt) ||
    !isNonEmptyString(value.deliveryId)
  ) {
    return false;
  }
  if (reduceAlertDelivery(undefined, value as AlertDelivery).decision === "rejected") {
    return false;
  }
  // Recomputes the exact same deterministic Alertmanager delivery identity
  // `canonicalizeAlertmanagerWebhook` uses (see `createAlertmanagerDeliveryId`
  // in ingestion.ts) from the delivery's own fingerprint/alertStatus/
  // startsAt/endsAt. A mismatch means `deliveryId` does not actually
  // correspond to the rest of the delivery — tampering, corruption, or a
  // stale value left over from an edit — and the dedup/checkpoint-conflict
  // logic that keys on `deliveryId` must not trust it.
  return (
    value.deliveryId ===
    createAlertmanagerDeliveryId({
      alertStatus: value.alertStatus as "firing" | "resolved",
      fingerprint: value.fingerprint as string,
      startsAt: value.startsAt as string,
      endsAt: value.endsAt as string | null,
    })
  );
}

function isDeferredCheckpoint(
  value: unknown,
): value is DeferredAlertDeliveryCheckpoint {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !isNonEmptyString(value.checkpointId) ||
    !isNonEmptyString(value.blockedByOccurrenceId) ||
    !isValidAlertDelivery(value.delivery)
  ) {
    return false;
  }
  // Recomputes the exact same deterministic id `planAlertDeliveryIngestion`
  // uses (see `computeDeferredAlertDeliveryCheckpointId` in ingestion.ts) —
  // a mismatch means the checkpoint was corrupted, hand-edited, or filed
  // under the wrong blocking occurrence.
  return (
    value.checkpointId ===
    computeDeferredAlertDeliveryCheckpointId(
      value.blockedByOccurrenceId,
      value.delivery.deliveryId,
    )
  );
}

export function decodeBridgeState(value: unknown): BridgeState {
  if (value === undefined) {
    return emptyState();
  }
  if (!isRecord(value) || value.schemaVersion !== BRIDGE_STATE_SCHEMA_VERSION) {
    throw new Error(
      `unsupported or invalid bridge state file (schemaVersion=${
        isRecord(value) ? String(value.schemaVersion) : "unknown"
      })`,
    );
  }
  if (!isRecord(value.routes) || !isRecord(value.checkpoints)) {
    throw new Error("bridge state file is missing routes or checkpoints");
  }
  for (const [fingerprint, route] of Object.entries(value.routes)) {
    if (!isNonEmptyString(fingerprint) || !isFingerprintRoute(route)) {
      throw new Error(`bridge state file has an invalid route entry: ${fingerprint}`);
    }
  }
  for (const [fingerprint, checkpoint] of Object.entries(value.checkpoints)) {
    if (!isNonEmptyString(fingerprint) || !isDeferredCheckpoint(checkpoint)) {
      throw new Error(
        `bridge state file has an invalid checkpoint entry: ${fingerprint}`,
      );
    }
    // A checkpoint is keyed by the fingerprint it belongs to; the held
    // delivery's own fingerprint must agree, or the checkpoint is either
    // corrupt or was filed under the wrong key.
    if (checkpoint.delivery.fingerprint !== fingerprint) {
      throw new Error(
        `bridge state file has a checkpoint filed under fingerprint ${fingerprint} whose delivery belongs to ${checkpoint.delivery.fingerprint}`,
      );
    }
    // A checkpoint only ever exists because *some* active occurrence has a
    // running remediation attempt blocking a newer delivery — there is
    // always a route for the fingerprint at the time the checkpoint is
    // created (see `hold_deferred_delivery` in `processor.ts`), and nothing
    // ever removes a route while its checkpoint survives. A checkpoint with
    // no route at all is therefore not "a fresh fingerprint with a held
    // delivery" — it is corrupt (or the route was lost independently of the
    // checkpoint) — and must not be treated as safe to route as a plain new
    // occurrence: that would silently bypass the very remediation attempt
    // `blockedByOccurrenceId` was recording.
    const route = value.routes[fingerprint];
    if (route === undefined) {
      throw new Error(
        `bridge state file has a checkpoint for fingerprint ${fingerprint} with no corresponding route`,
      );
    }
    if (!isFingerprintRoute(route)) {
      // Unreachable in practice: the route-validation loop above already
      // throws for this fingerprint before this loop runs. Kept as an
      // explicit failure (not a silent skip) for type-narrowing safety.
      throw new Error(`bridge state file has an invalid route entry: ${fingerprint}`);
    }
    // The checkpoint must be blocked by *that* route's occurrence — a
    // mismatch means the route advanced (or the checkpoint was left over
    // from a different occurrence) without the two being updated together.
    if (checkpoint.blockedByOccurrenceId !== route.occurrenceId) {
      throw new Error(
        `bridge state file has a checkpoint for fingerprint ${fingerprint} blocked by ${checkpoint.blockedByOccurrenceId}, but the route points at ${route.occurrenceId}`,
      );
    }
  }
  return value as unknown as BridgeState;
}

export type BridgeStateWriter = (path: string, value: unknown) => void;

/**
 * Loads and mutates bridge state entirely in memory, flushing the full file
 * durably on every mutation. Every mutator follows the same sequence:
 * build the candidate `nextState`, validate it with `decodeBridgeState`
 * (catching an internal bug before it ever reaches disk), durably write
 * it, and only *then* assign `this.state = nextState`. If the durable
 * write throws — full disk, permission error, anything — `this.state` is
 * left exactly as it was: a caller that sees the mutator throw can rely on
 * every subsequent `getRoute`/`getCheckpoint` call still reflecting only
 * what is actually on disk, never a value that was merely held in memory.
 * `writer` defaults to the real durable file writer and is injectable so
 * tests can simulate a write failure without touching a real filesystem.
 *
 * Mutations are synchronous end-to-end (no `await` between building
 * `nextState` and calling `writer`), so concurrent async request handling
 * for *different* fingerprints can never interleave mid-mutation: Node's
 * run-to-completion semantics make each mutator call an atomic step from
 * the event loop's point of view. Per-fingerprint ordering is still the
 * caller's responsibility (see `fingerprint-lock.ts`).
 */
export class BridgeStateStore {
  private state: BridgeState;
  private readonly writer: BridgeStateWriter;

  constructor(private readonly path: string, writer: BridgeStateWriter = writeJsonFileDurable) {
    this.writer = writer;
    this.state = decodeBridgeState(readJsonFileOrUndefined(path));
  }

  getRoute(fingerprint: string): FingerprintRoute | undefined {
    return this.state.routes[fingerprint];
  }

  getCheckpoint(fingerprint: string): DeferredAlertDeliveryCheckpoint | undefined {
    return this.state.checkpoints[fingerprint];
  }

  listCheckpointFingerprints(): string[] {
    return Object.keys(this.state.checkpoints);
  }

  setRoute(fingerprint: string, route: FingerprintRoute): void {
    this.commit({
      ...this.state,
      routes: { ...this.state.routes, [fingerprint]: route },
    });
  }

  setCheckpoint(
    fingerprint: string,
    checkpoint: DeferredAlertDeliveryCheckpoint,
  ): void {
    this.commit({
      ...this.state,
      checkpoints: { ...this.state.checkpoints, [fingerprint]: checkpoint },
    });
  }

  /**
   * Durably commits a new/updated route and removes any pending checkpoint
   * for the fingerprint in a single flush, so a reader never observes a
   * state where the route moved but the checkpoint it superseded is still
   * present (or vice versa).
   */
  commitRouteAndClearCheckpoint(
    fingerprint: string,
    route: FingerprintRoute,
  ): void {
    const { [fingerprint]: _removed, ...remainingCheckpoints } =
      this.state.checkpoints;
    this.commit({
      ...this.state,
      routes: { ...this.state.routes, [fingerprint]: route },
      checkpoints: remainingCheckpoints,
    });
  }

  deleteCheckpoint(fingerprint: string): void {
    if (!(fingerprint in this.state.checkpoints)) {
      return;
    }
    const { [fingerprint]: _removed, ...remainingCheckpoints } =
      this.state.checkpoints;
    this.commit({ ...this.state, checkpoints: remainingCheckpoints });
  }

  private commit(nextState: BridgeState): void {
    decodeBridgeState(nextState);
    this.writer(this.path, nextState);
    this.state = nextState;
  }
}
