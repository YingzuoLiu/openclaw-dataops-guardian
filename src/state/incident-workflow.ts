import type { MetricSnapshotResult } from "../tools/inspect-metric-snapshot.js";
import type { RemediationProposal } from "../tools/propose-remediation.js";
import {
  transitionIncidentState,
  type IncidentState,
} from "./incident-state.js";

export function openIncident(params: {
  alertId: string;
  occurredAt: string;
}): IncidentState {
  return {
    schemaVersion: 1,
    alertId: params.alertId,
    stage: "alert_received",
    evidence: [],
    proposedAction: null,
    approvalStatus: "not_requested",
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
          source: "guardian_inspect_metric_snapshot",
          observedAt,
          summary: result.evidenceSummary,
        },
      ],
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

  return transitionIncidentState(
    {
      ...validating,
      proposedAction: proposal.action,
      approvalStatus: "pending",
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
  params: { healthy: boolean; summary: string; checkedAt: string },
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
    retryCount: params.healthy ? state.retryCount : state.retryCount + 1,
  };

  return transitionIncidentState(
    withEvidence,
    params.healthy ? "completed" : "remediation",
    params.checkedAt,
  );
}
