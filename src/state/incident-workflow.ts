import type { MetricSnapshotResult } from "../tools/inspect-metric-snapshot.js";
import type { RemediationProposal } from "../tools/propose-remediation.js";
import { evaluateIncidentEvidence } from "../policy/evidence-policy.js";
import {
  MAX_REMEDIATION_RETRIES,
  transitionIncidentState,
  type IncidentState,
} from "./incident-state.js";

export function openIncident(params: {
  alertId: string;
  occurredAt: string;
}): IncidentState {
  return {
    schemaVersion: 2,
    alertId: params.alertId,
    stage: "alert_received",
    evidence: [],
    proposedAction: null,
    approvalStatus: "not_requested",
    evidenceValidation: {
      status: "not_checked",
      checkedAt: null,
      issues: [],
    },
    retryCount: 0,
    updatedAt: params.occurredAt,
  };
}

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

export function recordRemediationExecution(
  state: IncidentState,
  summary: string,
  executedAt: string,
): IncidentState {
  return transitionIncidentState(
    {
      ...state,
      evidence: [
        ...state.evidence,
        {
          source: "lobster_remediation",
          observedAt: executedAt,
          summary,
        },
      ],
    },
    "recovery_check",
    executedAt,
  );
}

export function recordRecoveryCheck(
  state: IncidentState,
  params: {
    healthy: boolean;
    summary: string;
    checkedAt: string;
    maxRetries?: number;
  },
): IncidentState {
  const maxRetries = params.maxRetries ?? MAX_REMEDIATION_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error("maxRetries must be a non-negative integer");
  }
  const nextRetryCount = params.healthy
    ? state.retryCount
    : state.retryCount + 1;
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
    retryCount: nextRetryCount,
  };

  return transitionIncidentState(
    withEvidence,
    params.healthy
      ? "completed"
      : nextRetryCount > maxRetries
        ? "blocked"
        : "remediation",
    params.checkedAt,
  );
}
