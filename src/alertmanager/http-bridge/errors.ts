/**
 * Thrown when the bridge's local route metadata and the Gateway's actual
 * session state disagree in a way that cannot be safely auto-healed: a
 * route points at a session the Gateway no longer has, or at one whose
 * value fails `readIncidentStateV3`. Recreating from scratch in either case
 * would silently discard whatever the destination session actually holds
 * (see docs/alertmanager-http-bridge.md's crash-window analysis), so the
 * caller must fail closed instead.
 */
export class BridgeConsistencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BridgeConsistencyError";
  }
}

/**
 * Thrown when a fingerprint already has a durably held deferred delivery
 * whose `deliveryId` differs from the one currently being processed. The
 * bridge holds exactly one checkpoint slot per fingerprint; overwriting it
 * would silently drop a delivery that already received an HTTP 2xx, so a
 * conflicting delivery is rejected instead and left for Alertmanager to
 * retry once the held one has been resolved.
 */
export class CheckpointConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointConflictError";
  }
}

/**
 * True for any error that means "this delivery could not be safely
 * processed right now" — the HTTP layer must map all of these to `503`
 * and must not acknowledge the webhook.
 */
export function isFailClosedError(error: unknown): boolean {
  return (
    error instanceof BridgeConsistencyError ||
    error instanceof CheckpointConflictError
  );
}
