import { createHash } from "node:crypto";

import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

export const INCIDENT_STATE_NAMESPACE = "incident";
export const MAX_REMEDIATION_RETRIES = 2;
export const MAX_REMEDIATION_ATTEMPTS = MAX_REMEDIATION_RETRIES + 1;
export const MAX_RECENT_DELIVERY_IDS = 50;

export const INCIDENT_STAGES = [
  "alert_received",
  "evidence_collection",
  "diagnosis",
  "validation",
  "approval",
  "remediation",
  "recovery_check",
  "completed",
  "blocked",
] as const;

export type IncidentStage = (typeof INCIDENT_STAGES)[number];

export type Evidence = {
  source: string;
  observedAt: string;
  summary: string;
};

export type EvidenceValidation = {
  status: "not_checked" | "passed" | "failed";
  checkedAt: string | null;
  issues: string[];
};

export type RemediationTarget = {
  [key: string]: PluginJsonValue;
};

export type RemediationAttempt = {
  idempotencyKey: string;
  target: RemediationTarget;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};

export type IncidentState = {
  schemaVersion: 3;
  alertId: string;
  fingerprint: string;
  occurrenceId: string;
  alertStatus: "firing" | "resolved";
  startsAt: string;
  endsAt: string | null;
  lastReceivedAt: string;
  deliveryCount: number;
  nonDuplicateDeliveryCount: number;
  recentDeliveryIds: string[];
  stage: IncidentStage;
  evidence: Evidence[];
  proposedAction: string | null;
  approvalStatus: "not_requested" | "pending" | "approved" | "denied";
  remediationAttempts: RemediationAttempt[];
  evidenceValidation: EvidenceValidation;
  updatedAt: string;
};

export type IncidentStateReadError =
  | "missing_state"
  | "unsupported_schema"
  | "invalid_state";

export type IncidentStateReadResult =
  | { ok: true; state: IncidentState }
  | {
      ok: false;
      error: IncidentStateReadError;
      issues: string[];
    };

const ALLOWED_STAGE_TRANSITIONS: Record<
  IncidentStage,
  readonly IncidentStage[]
> = {
  alert_received: ["evidence_collection", "blocked"],
  evidence_collection: ["diagnosis", "blocked"],
  diagnosis: ["validation", "blocked"],
  validation: ["evidence_collection", "approval", "blocked"],
  approval: ["remediation", "blocked"],
  remediation: ["recovery_check", "blocked"],
  recovery_check: ["remediation", "completed", "blocked"],
  completed: [],
  blocked: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.includes("T") &&
    Number.isFinite(Date.parse(value))
  );
}

function timestampMs(value: unknown): number | undefined {
  return isTimestamp(value) ? Date.parse(value) : undefined;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isFiniteJsonValue(
  value: unknown,
  ancestors: Set<object> = new Set(),
): value is PluginJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    return false;
  }
  if (Reflect.ownKeys(value).some((key) => typeof key === "symbol")) {
    return false;
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isFiniteJsonValue(entry, nextAncestors));
  }
  return Object.values(value).every((entry) =>
    isFiniteJsonValue(entry, nextAncestors),
  );
}

export function isRemediationTarget(
  value: unknown,
): value is RemediationTarget {
  return isRecord(value) && isFiniteJsonValue(value);
}

export function createIncidentOccurrenceId(
  fingerprint: string,
  startsAt: string,
): string {
  return createHash("sha256")
    .update(`incident-occurrence-v1\0${fingerprint}\0${startsAt}`)
    .digest("hex");
}

export function readIncidentStateV3(
  value: PluginJsonValue | undefined,
): IncidentStateReadResult {
  if (value === undefined) {
    return { ok: false, error: "missing_state", issues: ["state is missing"] };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: "invalid_state",
      issues: ["state must be a JSON object"],
    };
  }
  if (
    typeof value.schemaVersion === "number" &&
    value.schemaVersion !== 3
  ) {
    return {
      ok: false,
      error: "unsupported_schema",
      issues: [`unsupported incident schema: ${value.schemaVersion}`],
    };
  }

  const issues: string[] = [];
  if (value.schemaVersion !== 3) {
    issues.push("schemaVersion must equal 3");
  }
  if (!isNonEmptyString(value.alertId)) {
    issues.push("alertId must be a non-empty string");
  }
  if (!isNonEmptyString(value.fingerprint)) {
    issues.push("fingerprint must be a non-empty string");
  }
  if (!isNonEmptyString(value.occurrenceId)) {
    issues.push("occurrenceId must be a non-empty string");
  }
  if (!new Set(["firing", "resolved"]).has(value.alertStatus as string)) {
    issues.push("alertStatus must be firing or resolved");
  }

  const startsAtMs = timestampMs(value.startsAt);
  const endsAtMs =
    value.endsAt === null ? undefined : timestampMs(value.endsAt);
  const lastReceivedAtMs = timestampMs(value.lastReceivedAt);
  const updatedAtMs = timestampMs(value.updatedAt);
  if (startsAtMs === undefined) {
    issues.push("startsAt must be a valid timestamp");
  }
  if (value.endsAt !== null && endsAtMs === undefined) {
    issues.push("endsAt must be null or a valid timestamp");
  }
  if (lastReceivedAtMs === undefined) {
    issues.push("lastReceivedAt must be a valid timestamp");
  }
  if (updatedAtMs === undefined) {
    issues.push("updatedAt must be a valid timestamp");
  }
  if (
    startsAtMs !== undefined &&
    lastReceivedAtMs !== undefined &&
    lastReceivedAtMs < startsAtMs
  ) {
    issues.push("lastReceivedAt must not precede startsAt");
  }
  if (
    startsAtMs !== undefined &&
    endsAtMs !== undefined &&
    endsAtMs < startsAtMs
  ) {
    issues.push("endsAt must not precede startsAt");
  }
  if (
    lastReceivedAtMs !== undefined &&
    updatedAtMs !== undefined &&
    updatedAtMs < lastReceivedAtMs
  ) {
    issues.push("updatedAt must not precede lastReceivedAt");
  }
  if (value.alertStatus === "firing" && value.endsAt !== null) {
    issues.push("firing incidents must have endsAt=null");
  }
  if (value.alertStatus === "resolved" && value.endsAt === null) {
    issues.push("resolved incidents must have a non-null endsAt");
  }
  if (
    isNonEmptyString(value.fingerprint) &&
    isTimestamp(value.startsAt) &&
    value.occurrenceId !==
      createIncidentOccurrenceId(value.fingerprint, value.startsAt)
  ) {
    issues.push("occurrenceId does not match fingerprint and startsAt");
  }

  if (!isNonNegativeInteger(value.deliveryCount)) {
    issues.push("deliveryCount must be a non-negative integer");
  }
  if (!isNonNegativeInteger(value.nonDuplicateDeliveryCount)) {
    issues.push("nonDuplicateDeliveryCount must be a non-negative integer");
  }
  if (!Array.isArray(value.recentDeliveryIds)) {
    issues.push("recentDeliveryIds must be an array");
  } else {
    const recentIds = value.recentDeliveryIds;
    if (recentIds.length > MAX_RECENT_DELIVERY_IDS) {
      issues.push(
        `recentDeliveryIds must contain at most ${MAX_RECENT_DELIVERY_IDS} entries`,
      );
    }
    if (!recentIds.every(isNonEmptyString)) {
      issues.push("recentDeliveryIds entries must be non-empty strings");
    }
    if (new Set(recentIds).size !== recentIds.length) {
      issues.push("recentDeliveryIds entries must be unique");
    }
    if (
      isNonNegativeInteger(value.nonDuplicateDeliveryCount) &&
      value.nonDuplicateDeliveryCount < recentIds.length
    ) {
      issues.push(
        "nonDuplicateDeliveryCount must be at least recentDeliveryIds.length",
      );
    }
  }
  if (
    isNonNegativeInteger(value.deliveryCount) &&
    isNonNegativeInteger(value.nonDuplicateDeliveryCount) &&
    value.deliveryCount < value.nonDuplicateDeliveryCount
  ) {
    issues.push(
      "deliveryCount must be at least nonDuplicateDeliveryCount",
    );
  }

  if (!INCIDENT_STAGES.includes(value.stage as IncidentStage)) {
    issues.push("stage is invalid");
  }
  if (!Array.isArray(value.evidence)) {
    issues.push("evidence must be an array");
  } else {
    for (const entry of value.evidence) {
      if (
        !isRecord(entry) ||
        !isNonEmptyString(entry.source) ||
        !isTimestamp(entry.observedAt) ||
        typeof entry.summary !== "string"
      ) {
        issues.push("evidence entries are invalid");
        break;
      }
    }
  }
  if (
    value.proposedAction !== null &&
    !isNonEmptyString(value.proposedAction)
  ) {
    issues.push("proposedAction must be null or a non-empty string");
  }
  if (
    !new Set(["not_requested", "pending", "approved", "denied"]).has(
      value.approvalStatus as string,
    )
  ) {
    issues.push("approvalStatus is invalid");
  }

  let runningAttemptCount = 0;
  if (!Array.isArray(value.remediationAttempts)) {
    issues.push("remediationAttempts must be an array");
  } else {
    if (value.remediationAttempts.length > MAX_REMEDIATION_ATTEMPTS) {
      issues.push(
        `remediationAttempts must contain at most ${MAX_REMEDIATION_ATTEMPTS} entries`,
      );
    }
    const attemptKeys = new Set<string>();
    for (const attempt of value.remediationAttempts) {
      if (!isRecord(attempt)) {
        issues.push("remediation attempt must be an object");
        continue;
      }
      if (!isNonEmptyString(attempt.idempotencyKey)) {
        issues.push("remediation attempt key must be non-empty");
      } else if (attemptKeys.has(attempt.idempotencyKey)) {
        issues.push("remediation attempt keys must be unique");
      } else {
        attemptKeys.add(attempt.idempotencyKey);
      }
      if (!isRemediationTarget(attempt.target)) {
        issues.push(
          "remediation attempt target must contain finite JSON-compatible values",
        );
      }
      if (
        !new Set(["running", "succeeded", "failed"]).has(
          attempt.status as string,
        )
      ) {
        issues.push("remediation attempt status is invalid");
      }
      const startedAtMs = timestampMs(attempt.startedAt);
      const finishedAtMs =
        attempt.finishedAt === null
          ? undefined
          : timestampMs(attempt.finishedAt);
      if (startedAtMs === undefined) {
        issues.push("remediation attempt startedAt must be valid");
      }
      if (attempt.finishedAt !== null && finishedAtMs === undefined) {
        issues.push("remediation attempt finishedAt must be null or valid");
      }
      if (
        startedAtMs !== undefined &&
        finishedAtMs !== undefined &&
        finishedAtMs < startedAtMs
      ) {
        issues.push("remediation attempt finishedAt must not precede startedAt");
      }
      if (
        startsAtMs !== undefined &&
        startedAtMs !== undefined &&
        startedAtMs < startsAtMs
      ) {
        issues.push("remediation attempt startedAt must not precede startsAt");
      }
      if (
        updatedAtMs !== undefined &&
        ((startedAtMs !== undefined && startedAtMs > updatedAtMs) ||
          (finishedAtMs !== undefined && finishedAtMs > updatedAtMs))
      ) {
        issues.push("remediation attempt timestamps must not exceed updatedAt");
      }
      if (attempt.status === "running") {
        runningAttemptCount += 1;
        if (attempt.finishedAt !== null || attempt.error !== null) {
          issues.push("running remediation attempts must be unfinished");
        }
      }
      if (
        attempt.status === "succeeded" &&
        (attempt.finishedAt === null || attempt.error !== null)
      ) {
        issues.push(
          "succeeded remediation attempts require finishedAt and error=null",
        );
      }
      if (
        attempt.status === "failed" &&
        (attempt.finishedAt === null || !isNonEmptyString(attempt.error))
      ) {
        issues.push(
          "failed remediation attempts require finishedAt and a non-empty error",
        );
      }
    }
  }
  if (runningAttemptCount > 1) {
    issues.push("at most one remediation attempt may be running");
  }
  if (
    runningAttemptCount === 1 &&
    (value.approvalStatus !== "approved" ||
      !new Set(["remediation", "blocked"]).has(value.stage as string))
  ) {
    issues.push(
      "a running remediation attempt requires approved remediation or blocked stage",
    );
  }

  if (!isRecord(value.evidenceValidation)) {
    issues.push("evidenceValidation must be an object");
  } else {
    if (
      !new Set(["not_checked", "passed", "failed"]).has(
        value.evidenceValidation.status as string,
      )
    ) {
      issues.push("evidenceValidation.status is invalid");
    }
    if (
      value.evidenceValidation.checkedAt !== null &&
      !isTimestamp(value.evidenceValidation.checkedAt)
    ) {
      issues.push("evidenceValidation.checkedAt must be null or valid");
    }
    if (
      !Array.isArray(value.evidenceValidation.issues) ||
      !value.evidenceValidation.issues.every(
        (issue) => typeof issue === "string",
      )
    ) {
      issues.push("evidenceValidation.issues must be a string array");
    }
  }

  if (issues.length > 0) {
    return { ok: false, error: "invalid_state", issues };
  }
  return { ok: true, state: value as IncidentState };
}

export function transitionIncidentState(
  state: IncidentState,
  nextStage: IncidentStage,
  updatedAt: string,
): IncidentState {
  if (state.stage === nextStage) {
    return state;
  }

  if (!ALLOWED_STAGE_TRANSITIONS[state.stage].includes(nextStage)) {
    throw new Error(
      `invalid incident stage transition: ${state.stage} -> ${nextStage}`,
    );
  }

  return {
    ...state,
    stage: nextStage,
    updatedAt,
  };
}

export function projectIncidentState(
  state: PluginJsonValue | undefined,
): PluginJsonValue | undefined {
  return state;
}
