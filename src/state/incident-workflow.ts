import type { MetricSnapshotResult } from "../tools/inspect-metric-snapshot.js";
import type { RemediationProposal } from "../tools/propose-remediation.js";
import { evaluateIncidentEvidence } from "../policy/evidence-policy.js";
import {
  isRemediationTarget,
  MAX_REMEDIATION_ATTEMPTS,
  transitionIncidentState,
  type IncidentState,
  type RemediationAttempt,
  type RemediationTarget,
} from "./incident-state.js";

export function recordMetricEvidence(
  state: IncidentState,
  result: MetricSnapshotResult,
  observedAt: string,
): IncidentState {
  const collecting = transitionIncidentState(
    state,
    "evidence_collection",
    observedAt,
  );

  return transitionIncidentState(
    {
      ...collecting,
      evidence: [
        ...collecting.evidence,
        {
          source: result.source,
          observedAt,
          summary: result.evidenceSummary,
        },
      ],
      evidenceValidation: {
        status: "not_checked",
        checkedAt: null,
        issues: [],
      },
    },
    "diagnosis",
    observedAt,
  );
}

export function recordRemediationProposal(
  state: IncidentState,
  proposal: RemediationProposal,
  proposedAt: string,
): IncidentState {
  const validating = transitionIncidentState(state, "validation", proposedAt);
  const validation = evaluateIncidentEvidence(validating, proposedAt);

  if (!validation.ok) {
    return transitionIncidentState(
      {
        ...validating,
        evidenceValidation: {
          status: "failed",
          checkedAt: validation.checkedAt,
          issues: validation.issues,
        },
      },
      "evidence_collection",
      proposedAt,
    );
  }

  return transitionIncidentState(
    {
      ...validating,
      proposedAction: proposal.action,
      approvalStatus: "pending",
      evidenceValidation: {
        status: "passed",
        checkedAt: validation.checkedAt,
        issues: [],
      },
      evidence: [
        ...validating.evidence,
        {
          source: "guardian_propose_remediation",
          observedAt: proposedAt,
          summary: proposal.rationale,
        },
      ],
    },
    "approval",
    proposedAt,
  );
}

export function recordApprovalDecision(
  state: IncidentState,
  approved: boolean,
  decidedAt: string,
): IncidentState {
  return transitionIncidentState(
    {
      ...state,
      approvalStatus: approved ? "approved" : "denied",
    },
    approved ? "remediation" : "blocked",
    decidedAt,
  );
}

export function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) =>
        jsonValuesEqual(entry, right[index]),
      )
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object" &&
    !Array.isArray(left) &&
    !Array.isArray(right)
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          jsonValuesEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
}

export type BeginRemediationAttemptDecision =
  | "started"
  | "duplicate"
  | "idempotency_conflict"
  | "running_attempt_exists"
  | "attempt_limit_reached"
  | "rejected";

export function beginRemediationAttempt(
  state: IncidentState,
  input: {
    idempotencyKey: string;
    target: RemediationTarget;
    startedAt: string;
  },
): {
  decision: BeginRemediationAttemptDecision;
  state: IncidentState;
} {
  if (
    typeof input.idempotencyKey !== "string" ||
    input.idempotencyKey.trim().length === 0 ||
    !isRemediationTarget(input.target) ||
    !Number.isFinite(Date.parse(input.startedAt))
  ) {
    return { decision: "rejected", state };
  }

  const existing = state.remediationAttempts.find(
    (attempt) => attempt.idempotencyKey === input.idempotencyKey,
  );
  if (existing) {
    return {
      decision: jsonValuesEqual(existing.target, input.target)
        ? "duplicate"
        : "idempotency_conflict",
      state,
    };
  }
  if (
    state.remediationAttempts.some((attempt) => attempt.status === "running")
  ) {
    return { decision: "running_attempt_exists", state };
  }
  if (state.remediationAttempts.length >= MAX_REMEDIATION_ATTEMPTS) {
    return { decision: "attempt_limit_reached", state };
  }
  if (state.approvalStatus !== "approved" || state.stage !== "remediation") {
    return { decision: "rejected", state };
  }

  const attempt: RemediationAttempt = {
    idempotencyKey: input.idempotencyKey,
    target: structuredClone(input.target),
    status: "running",
    startedAt: input.startedAt,
    finishedAt: null,
    error: null,
  };
  return {
    decision: "started",
    state: {
      ...state,
      remediationAttempts: [...state.remediationAttempts, attempt],
      updatedAt: input.startedAt,
    },
  };
}

export type FinishRemediationAttemptDecision =
  | "recorded"
  | "no_running_attempt"
  | "running_key_mismatch"
  | "rejected";

export function finishRemediationAttempt(
  state: IncidentState,
  input: {
    idempotencyKey: string;
    status: "succeeded" | "failed";
    finishedAt: string;
    error: string | null;
  },
): {
  decision: FinishRemediationAttemptDecision;
  state: IncidentState;
} {
  if (
    !new Set(["succeeded", "failed"]).has(input.status) ||
    !Number.isFinite(Date.parse(input.finishedAt)) ||
    (input.status === "succeeded" && input.error !== null) ||
    (input.status === "failed" &&
      (typeof input.error !== "string" || input.error.trim().length === 0))
  ) {
    return { decision: "rejected", state };
  }

  const runningIndex = state.remediationAttempts.findIndex(
    (attempt) => attempt.status === "running",
  );
  if (runningIndex === -1) {
    return { decision: "no_running_attempt", state };
  }
  const running = state.remediationAttempts[runningIndex];
  if (!running || running.idempotencyKey !== input.idempotencyKey) {
    return { decision: "running_key_mismatch", state };
  }
  if (Date.parse(input.finishedAt) < Date.parse(running.startedAt)) {
    return { decision: "rejected", state };
  }

  const finished: RemediationAttempt = {
    ...running,
    status: input.status,
    finishedAt: input.finishedAt,
    error: input.error,
  };
  const attempts = state.remediationAttempts.map((attempt, index) =>
    index === runningIndex ? finished : attempt,
  );
  const withResult: IncidentState = {
    ...state,
    remediationAttempts: attempts,
    evidence: [
      ...state.evidence,
      {
        source: "lobster_remediation",
        observedAt: input.finishedAt,
        summary:
          input.status === "succeeded"
            ? "Remediation attempt succeeded."
            : `Remediation attempt failed: ${input.error}`,
      },
    ],
    updatedAt: input.finishedAt,
  };
  const nextStage =
    input.status === "succeeded"
      ? "recovery_check"
      : attempts.length >= MAX_REMEDIATION_ATTEMPTS
        ? "blocked"
        : "remediation";

  return {
    decision: "recorded",
    state:
      nextStage === withResult.stage
        ? withResult
        : transitionIncidentState(
            withResult,
            nextStage,
            input.finishedAt,
          ),
  };
}

export function recordRecoveryCheck(
  state: IncidentState,
  params: {
    healthy: boolean;
    summary: string;
    checkedAt: string;
  },
): IncidentState {
  const withEvidence: IncidentState = {
    ...state,
    evidence: [
      ...state.evidence,
      {
        source: "lobster_recovery_check",
        observedAt: params.checkedAt,
        summary: params.summary,
      },
    ],
    updatedAt: params.checkedAt,
  };
  const nextStage = params.healthy
    ? "completed"
    : state.remediationAttempts.length >= MAX_REMEDIATION_ATTEMPTS
      ? "blocked"
      : "remediation";

  return transitionIncidentState(
    withEvidence,
    nextStage,
    params.checkedAt,
  );
}
