import type { DeferredAlertDeliveryCheckpoint } from "../ingestion.js";
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

function isFingerprintRoute(value: unknown): value is FingerprintRoute {
  return (
    isRecord(value) &&
    isNonEmptyString(value.occurrenceId) &&
    isNonEmptyString(value.sessionKey)
  );
}

function isDeferredCheckpoint(
  value: unknown,
): value is DeferredAlertDeliveryCheckpoint {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    isNonEmptyString(value.checkpointId) &&
    isNonEmptyString(value.blockedByOccurrenceId) &&
    isRecord(value.delivery)
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
  }
  return value as unknown as BridgeState;
}

/**
 * Loads and mutates bridge state entirely in memory, flushing the full file
 * durably on every mutation. Mutations are synchronous end-to-end (no
 * `await` between reading the in-memory object and calling
 * `writeJsonFileDurable`), so concurrent async request handling for
 * *different* fingerprints can never interleave mid-mutation: Node's
 * run-to-completion semantics make each `mutate*` call an atomic step from
 * the event loop's point of view. Per-fingerprint ordering is still the
 * caller's responsibility (see `fingerprint-lock.ts`).
 */
export class BridgeStateStore {
  private state: BridgeState;

  constructor(private readonly path: string) {
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
    this.state = {
      ...this.state,
      routes: { ...this.state.routes, [fingerprint]: route },
    };
    this.flush();
  }

  setCheckpoint(
    fingerprint: string,
    checkpoint: DeferredAlertDeliveryCheckpoint,
  ): void {
    this.state = {
      ...this.state,
      checkpoints: { ...this.state.checkpoints, [fingerprint]: checkpoint },
    };
    this.flush();
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
    this.state = {
      ...this.state,
      routes: { ...this.state.routes, [fingerprint]: route },
      checkpoints: remainingCheckpoints,
    };
    this.flush();
  }

  deleteCheckpoint(fingerprint: string): void {
    if (!(fingerprint in this.state.checkpoints)) {
      return;
    }
    const { [fingerprint]: _removed, ...remainingCheckpoints } =
      this.state.checkpoints;
    this.state = { ...this.state, checkpoints: remainingCheckpoints };
    this.flush();
  }

  private flush(): void {
    writeJsonFileDurable(this.path, this.state);
  }
}
