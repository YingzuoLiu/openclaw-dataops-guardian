import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  createIncidentOccurrenceId,
  MAX_RECENT_DELIVERY_IDS,
  readIncidentStateV3,
  type IncidentState,
} from "./incident-state.js";

export { MAX_RECENT_DELIVERY_IDS } from "./incident-state.js";

export type AlertDelivery = {
  alertId: string;
  fingerprint: string;
  alertStatus: "firing" | "resolved";
  startsAt: string;
  endsAt: string | null;
  receivedAt: string;
  deliveryId: string;
};

export type AlertDeliveryRejectionReason =
  | "invalid_alert_id"
  | "invalid_fingerprint"
  | "invalid_delivery_id"
  | "invalid_alert_status"
  | "invalid_timestamp"
  | "received_before_start"
  | "firing_with_ends_at"
  | "invalid_resolved_ends_at"
  | "unsupported_schema"
  | "invalid_state"
  | "fingerprint_mismatch"
  | "alert_id_mismatch"
  | "received_at_regression";

/**
 * The meaning of `state` depends on `decision`:
 *
 * - `created` / `updated` / `duplicate` / `stale_refire`: the state the caller
 *   should persist for the current occurrence.
 * - `new_occurrence`: the *unchanged* current occurrence. The caller can route
 *   the new delivery to an independent occurrence.
 * - `deferred_new_occurrence`: the *unchanged* current occurrence with an
 *   in-flight remediation attempt. The caller must retain the delivery until
 *   that attempt is settled and must not route it yet.
 * - `orphan_resolved` / `rejected`: the unchanged current occurrence when one
 *   exists, otherwise `undefined`. Nothing should be persisted.
 */
export type AlertDeliveryResult =
  | {
      decision: "created" | "updated" | "duplicate" | "stale_refire";
      state: IncidentState;
      reason?: never;
    }
  | {
      decision: "new_occurrence";
      state: IncidentState;
      reason?: never;
    }
  | {
      decision: "deferred_new_occurrence";
      state: IncidentState;
      reason?: never;
    }
  | {
      decision: "orphan_resolved";
      state: IncidentState | undefined;
      reason: "no_matching_occurrence";
    }
  | {
      decision: "rejected";
      state: IncidentState | undefined;
      reason: AlertDeliveryRejectionReason;
    };

export type AlertDeliveryDecision = AlertDeliveryResult["decision"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.includes("T")) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validateDelivery(
  delivery: AlertDelivery,
): AlertDeliveryRejectionReason | undefined {
  if (!isNonEmptyString(delivery.alertId)) {
    return "invalid_alert_id";
  }
  if (!isNonEmptyString(delivery.fingerprint)) {
    return "invalid_fingerprint";
  }
  if (!isNonEmptyString(delivery.deliveryId)) {
    return "invalid_delivery_id";
  }
  if (!new Set(["firing", "resolved"]).has(delivery.alertStatus)) {
    return "invalid_alert_status";
  }

  const startsAtMs = timestampMs(delivery.startsAt);
  const receivedAtMs = timestampMs(delivery.receivedAt);
  const endsAtMs =
    delivery.endsAt === null ? undefined : timestampMs(delivery.endsAt);
  if (startsAtMs === undefined || receivedAtMs === undefined) {
    return "invalid_timestamp";
  }
  if (receivedAtMs < startsAtMs) {
    return "received_before_start";
  }
  if (delivery.alertStatus === "firing" && delivery.endsAt !== null) {
    return "firing_with_ends_at";
  }
  if (
    delivery.alertStatus === "resolved" &&
    (endsAtMs === undefined || endsAtMs < startsAtMs)
  ) {
    return "invalid_resolved_ends_at";
  }
  return undefined;
}

function createIncident(delivery: AlertDelivery): IncidentState {
  return {
    schemaVersion: 3,
    alertId: delivery.alertId,
    fingerprint: delivery.fingerprint,
    occurrenceId: createIncidentOccurrenceId(
      delivery.fingerprint,
      delivery.startsAt,
    ),
    alertStatus: delivery.alertStatus,
    startsAt: delivery.startsAt,
    endsAt: delivery.endsAt,
    lastReceivedAt: delivery.receivedAt,
    deliveryCount: 1,
    nonDuplicateDeliveryCount: 1,
    recentDeliveryIds: [delivery.deliveryId],
    stage: "alert_received",
    evidence: [],
    proposedAction: null,
    approvalStatus: "not_requested",
    remediationAttempts: [],
    evidenceValidation: {
      status: "not_checked",
      checkedAt: null,
      issues: [],
    },
    updatedAt: delivery.receivedAt,
  };
}

function appendRecentDeliveryId(
  recentDeliveryIds: string[],
  deliveryId: string,
): string[] {
  return [...recentDeliveryIds, deliveryId].slice(
    -MAX_RECENT_DELIVERY_IDS,
  );
}

/**
 * `updatedAt` is the incident's logical clock: every other invariant
 * (`lastReceivedAt <= updatedAt`, remediation attempt timestamps
 * `<= updatedAt`, ...) is expressed relative to it. A delivery's
 * `receivedAt` only has to be non-decreasing against the *previous
 * delivery's* `receivedAt` (see the `received_at_regression` check above),
 * not against work the incident may have done meanwhile (evidence
 * collection, approval, a remediation attempt). A late-but-otherwise-valid
 * redelivery — an Alertmanager retry, a duplicate from an HA replica, a
 * delayed queue entry — can therefore carry a `receivedAt` that is older
 * than the incident's current `updatedAt`. Applying it as-is would move
 * `updatedAt` backward, past timestamps already recorded on the state
 * (e.g. a running remediation attempt's `startedAt`), producing a state
 * that fails `readIncidentStateV3`. Clamping forward-only here keeps
 * `updatedAt` monotonic while `lastReceivedAt` still reflects the
 * delivery's own `receivedAt` for delivery-ordering purposes.
 */
function monotonicUpdatedAt(previousUpdatedAt: string, candidate: string): string {
  return Date.parse(candidate) > Date.parse(previousUpdatedAt)
    ? candidate
    : previousUpdatedAt;
}

export function reduceAlertDelivery(
  current: PluginJsonValue | undefined,
  delivery: AlertDelivery,
): AlertDeliveryResult {
  const deliveryIssue = validateDelivery(delivery);
  if (deliveryIssue) {
    return {
      decision: "rejected",
      state: undefined,
      reason: deliveryIssue,
    };
  }

  const decoded = readIncidentStateV3(current);
  if (!decoded.ok) {
    if (decoded.error === "missing_state") {
      if (delivery.alertStatus === "resolved") {
        return {
          decision: "orphan_resolved",
          state: undefined,
          reason: "no_matching_occurrence",
        };
      }
      return { decision: "created", state: createIncident(delivery) };
    }
    return {
      decision: "rejected",
      state: undefined,
      reason: decoded.error,
    };
  }

  const state = decoded.state;
  if (delivery.fingerprint !== state.fingerprint) {
    return {
      decision: "rejected",
      state,
      reason: "fingerprint_mismatch",
    };
  }
  if (delivery.startsAt !== state.startsAt) {
    if (delivery.alertStatus === "resolved") {
      return {
        decision: "orphan_resolved",
        state,
        reason: "no_matching_occurrence",
      };
    }
    const hasRunningAttempt = state.remediationAttempts.some(
      (attempt) => attempt.status === "running",
    );
    return {
      decision: hasRunningAttempt
        ? "deferred_new_occurrence"
        : "new_occurrence",
      state,
    };
  }
  if (delivery.alertId !== state.alertId) {
    return {
      decision: "rejected",
      state,
      reason: "alert_id_mismatch",
    };
  }
  if (Date.parse(delivery.receivedAt) < Date.parse(state.lastReceivedAt)) {
    return {
      decision: "rejected",
      state,
      reason: "received_at_regression",
    };
  }

  if (state.recentDeliveryIds.includes(delivery.deliveryId)) {
    return {
      decision: "duplicate",
      state: {
        ...state,
        deliveryCount: state.deliveryCount + 1,
        lastReceivedAt: delivery.receivedAt,
        updatedAt: monotonicUpdatedAt(state.updatedAt, delivery.receivedAt),
      },
    };
  }

  const withDelivery: IncidentState = {
    ...state,
    deliveryCount: state.deliveryCount + 1,
    nonDuplicateDeliveryCount: state.nonDuplicateDeliveryCount + 1,
    recentDeliveryIds: appendRecentDeliveryId(
      state.recentDeliveryIds,
      delivery.deliveryId,
    ),
    lastReceivedAt: delivery.receivedAt,
    updatedAt: monotonicUpdatedAt(state.updatedAt, delivery.receivedAt),
  };

  if (
    state.alertStatus === "resolved" &&
    delivery.alertStatus === "firing"
  ) {
    return { decision: "stale_refire", state: withDelivery };
  }

  return {
    decision: "updated",
    state: {
      ...withDelivery,
      alertStatus: delivery.alertStatus,
      endsAt: delivery.endsAt,
    },
  };
}
