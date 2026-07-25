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

export type AlertDeliveryDecision =
  | "created"
  | "updated"
  | "duplicate"
  | "new_occurrence"
  | "orphan_resolved"
  | "stale_refire"
  | "rejected";

export type AlertDeliveryResult = {
  decision: AlertDeliveryDecision;
  state: IncidentState | undefined;
  reason?: string;
};

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

function validateDelivery(delivery: AlertDelivery): string | undefined {
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
  if (!decoded.ok && decoded.error === "missing_state") {
    if (delivery.alertStatus === "resolved") {
      return {
        decision: "orphan_resolved",
        state: undefined,
        reason: "no_matching_occurrence",
      };
    }
    return { decision: "created", state: createIncident(delivery) };
  }
  if (!decoded.ok) {
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
    return {
      decision: "new_occurrence",
      state,
      reason: state.remediationAttempts.some(
        (attempt) => attempt.status === "running",
      )
        ? "previous_attempt_running"
        : "route_to_new_occurrence",
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
        updatedAt: delivery.receivedAt,
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
    updatedAt: delivery.receivedAt,
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
