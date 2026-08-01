import { createHash } from "node:crypto";

import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  reduceAlertDelivery,
  type AlertDelivery,
  type AlertDeliveryRejectionReason,
} from "../state/incident-reducer.js";
import type { IncidentState } from "../state/incident-state.js";

export const ALERTMANAGER_WEBHOOK_VERSION = "4";
export const DEFERRED_ALERT_DELIVERY_CHECKPOINT_VERSION = 1;

export type AlertmanagerEnvelopeRejectionReason =
  | "invalid_payload"
  | "unsupported_version"
  | "invalid_group_status"
  | "invalid_group_key"
  | "invalid_receiver"
  | "invalid_truncated_alerts"
  | "invalid_alerts"
  | "invalid_received_at";

export type AlertmanagerAlertRejectionReason =
  | "invalid_alert"
  | "invalid_alert_status"
  | "invalid_labels"
  | "missing_alertname"
  | "invalid_annotations"
  | "invalid_generator_url"
  | "invalid_fingerprint"
  | "invalid_starts_at"
  | "received_before_start"
  | "invalid_resolved_ends_at";

export type CanonicalAlertmanagerAlert = {
  index: number;
  delivery: AlertDelivery;
};

export type RejectedAlertmanagerAlert = {
  index: number;
  reason: AlertmanagerAlertRejectionReason;
};

export type AlertmanagerWebhookMetadata = {
  version: "4";
  groupKey: string;
  groupStatus: "firing" | "resolved";
  receiver: string;
  truncatedAlerts: number;
};

export type AlertmanagerWebhookCanonicalizationResult =
  | {
      ok: true;
      metadata: AlertmanagerWebhookMetadata;
      acceptedAlerts: CanonicalAlertmanagerAlert[];
      rejectedAlerts: RejectedAlertmanagerAlert[];
    }
  | {
      ok: false;
      reason: AlertmanagerEnvelopeRejectionReason;
    };

export type DeferredAlertDeliveryCheckpoint = {
  schemaVersion: 1;
  checkpointId: string;
  blockedByOccurrenceId: string;
  delivery: AlertDelivery;
};

export type AlertDeliveryIngestionPlan =
  | {
      action: "persist_occurrence";
      decision: "created" | "updated" | "duplicate" | "stale_refire";
      occurrenceId: string;
      state: IncidentState;
    }
  | {
      action: "persist_new_occurrence";
      decision: "new_occurrence";
      previousOccurrenceId: string;
      occurrenceId: string;
      state: IncidentState;
    }
  | {
      action: "hold_deferred_delivery";
      decision: "deferred_new_occurrence";
      currentState: IncidentState;
      checkpoint: DeferredAlertDeliveryCheckpoint;
    }
  | {
      action: "ignore_orphan_resolved";
      decision: "orphan_resolved";
      reason: "no_matching_occurrence";
      currentState: IncidentState | undefined;
    }
  | {
      action: "reject_delivery";
      decision: "rejected";
      reason: AlertDeliveryRejectionReason;
      currentState: IncidentState | undefined;
    };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    !Reflect.ownKeys(value).some((key) => typeof key === "symbol")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isPlainRecord(value) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function canonicalTimestamp(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    )
  ) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function createAlertmanagerDeliveryId(input: {
  groupKey: string;
  receiver: string;
  alertStatus: "firing" | "resolved";
  fingerprint: string;
  startsAt: string;
  endsAt: string | null;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  generatorURL: string;
}): string {
  const identity = stableJson({
    schema: "alertmanager-delivery-v1",
    ...input,
  });
  return `am-v4:${createHash("sha256").update(identity).digest("hex")}`;
}

function canonicalizeAlert(
  value: unknown,
  context: {
    index: number;
    groupKey: string;
    receiver: string;
    receivedAt: string;
  },
): CanonicalAlertmanagerAlert | RejectedAlertmanagerAlert {
  const reject = (
    reason: AlertmanagerAlertRejectionReason,
  ): RejectedAlertmanagerAlert => ({ index: context.index, reason });

  if (!isPlainRecord(value)) {
    return reject("invalid_alert");
  }
  if (!new Set(["firing", "resolved"]).has(value.status as string)) {
    return reject("invalid_alert_status");
  }
  if (!isStringMap(value.labels)) {
    return reject("invalid_labels");
  }
  const alertId = value.labels.alertname;
  if (!isNonEmptyString(alertId)) {
    return reject("missing_alertname");
  }
  if (!isStringMap(value.annotations)) {
    return reject("invalid_annotations");
  }
  if (typeof value.generatorURL !== "string") {
    return reject("invalid_generator_url");
  }
  if (!isNonEmptyString(value.fingerprint)) {
    return reject("invalid_fingerprint");
  }

  const startsAt = canonicalTimestamp(value.startsAt);
  if (startsAt === undefined) {
    return reject("invalid_starts_at");
  }
  if (Date.parse(context.receivedAt) < Date.parse(startsAt)) {
    return reject("received_before_start");
  }

  const alertStatus = value.status as "firing" | "resolved";
  let endsAt: string | null = null;
  if (alertStatus === "resolved") {
    const resolvedEndsAt = canonicalTimestamp(value.endsAt);
    if (
      resolvedEndsAt === undefined ||
      Date.parse(resolvedEndsAt) < Date.parse(startsAt)
    ) {
      return reject("invalid_resolved_ends_at");
    }
    endsAt = resolvedEndsAt;
  }

  const deliveryId = createAlertmanagerDeliveryId({
    groupKey: context.groupKey,
    receiver: context.receiver,
    alertStatus,
    fingerprint: value.fingerprint,
    startsAt,
    endsAt,
    labels: value.labels,
    annotations: value.annotations,
    generatorURL: value.generatorURL,
  });

  return {
    index: context.index,
    delivery: {
      alertId,
      fingerprint: value.fingerprint,
      alertStatus,
      startsAt,
      endsAt,
      receivedAt: context.receivedAt,
      deliveryId,
    },
  };
}

/**
 * Converts an untrusted Alertmanager webhook v4 payload into the smaller
 * delivery contract accepted by the incident reducer. Alert labels and
 * annotations participate only in delivery identity; they never become
 * incident evidence.
 */
export function canonicalizeAlertmanagerWebhook(
  payload: unknown,
  receivedAt: string,
): AlertmanagerWebhookCanonicalizationResult {
  if (!isPlainRecord(payload)) {
    return { ok: false, reason: "invalid_payload" };
  }
  if (payload.version !== ALERTMANAGER_WEBHOOK_VERSION) {
    return { ok: false, reason: "unsupported_version" };
  }
  if (!new Set(["firing", "resolved"]).has(payload.status as string)) {
    return { ok: false, reason: "invalid_group_status" };
  }
  if (!isNonEmptyString(payload.groupKey)) {
    return { ok: false, reason: "invalid_group_key" };
  }
  if (!isNonEmptyString(payload.receiver)) {
    return { ok: false, reason: "invalid_receiver" };
  }
  if (
    !Number.isInteger(payload.truncatedAlerts) ||
    (payload.truncatedAlerts as number) < 0
  ) {
    return { ok: false, reason: "invalid_truncated_alerts" };
  }
  if (!Array.isArray(payload.alerts) || payload.alerts.length === 0) {
    return { ok: false, reason: "invalid_alerts" };
  }
  const canonicalReceivedAt = canonicalTimestamp(receivedAt);
  if (canonicalReceivedAt === undefined) {
    return { ok: false, reason: "invalid_received_at" };
  }

  const acceptedAlerts: CanonicalAlertmanagerAlert[] = [];
  const rejectedAlerts: RejectedAlertmanagerAlert[] = [];
  payload.alerts.forEach((alert, index) => {
    const result = canonicalizeAlert(alert, {
      index,
      groupKey: payload.groupKey as string,
      receiver: payload.receiver as string,
      receivedAt: canonicalReceivedAt,
    });
    if ("delivery" in result) {
      acceptedAlerts.push(result);
    } else {
      rejectedAlerts.push(result);
    }
  });

  return {
    ok: true,
    metadata: {
      version: ALERTMANAGER_WEBHOOK_VERSION,
      groupKey: payload.groupKey,
      groupStatus: payload.status as "firing" | "resolved",
      receiver: payload.receiver,
      truncatedAlerts: payload.truncatedAlerts as number,
    },
    acceptedAlerts,
    rejectedAlerts,
  };
}

function createDeferredCheckpoint(
  currentState: IncidentState,
  delivery: AlertDelivery,
): DeferredAlertDeliveryCheckpoint {
  const checkpointId = createHash("sha256")
    .update(
      `deferred-alert-delivery-v1\0${currentState.occurrenceId}\0${delivery.deliveryId}`,
    )
    .digest("hex");
  return {
    schemaVersion: DEFERRED_ALERT_DELIVERY_CHECKPOINT_VERSION,
    checkpointId,
    blockedByOccurrenceId: currentState.occurrenceId,
    delivery: structuredClone(delivery),
  };
}

function assertNever(value: never): never {
  throw new Error(`unhandled alert delivery decision: ${JSON.stringify(value)}`);
}

/**
 * Exhaustively translates reducer decisions into bridge-owned persistence
 * actions. It performs no I/O and dispatches no investigation or remediation.
 */
export function planAlertDeliveryIngestion(
  current: PluginJsonValue | undefined,
  delivery: AlertDelivery,
): AlertDeliveryIngestionPlan {
  const result = reduceAlertDelivery(current, delivery);
  switch (result.decision) {
    case "created":
    case "updated":
    case "duplicate":
    case "stale_refire":
      return {
        action: "persist_occurrence",
        decision: result.decision,
        occurrenceId: result.state.occurrenceId,
        state: result.state,
      };
    case "new_occurrence": {
      const created = reduceAlertDelivery(undefined, delivery);
      if (created.decision !== "created") {
        throw new Error(
          `new occurrence could not be created: ${created.decision}`,
        );
      }
      return {
        action: "persist_new_occurrence",
        decision: "new_occurrence",
        previousOccurrenceId: result.state.occurrenceId,
        occurrenceId: created.state.occurrenceId,
        state: created.state,
      };
    }
    case "deferred_new_occurrence":
      return {
        action: "hold_deferred_delivery",
        decision: "deferred_new_occurrence",
        currentState: result.state,
        checkpoint: createDeferredCheckpoint(result.state, delivery),
      };
    case "orphan_resolved":
      return {
        action: "ignore_orphan_resolved",
        decision: "orphan_resolved",
        reason: result.reason,
        currentState: result.state,
      };
    case "rejected":
      return {
        action: "reject_delivery",
        decision: "rejected",
        reason: result.reason,
        currentState: result.state,
      };
    default:
      return assertNever(result);
  }
}
