import type { IncidentState, RemediationTarget } from "../state/incident-state.js";
import {
  beginRemediationAttempt,
  recordApprovalDecision,
} from "../state/incident-workflow.js";

export type IncidentStateWriter = {
  persistIncidentState(sessionKey: string, state: IncidentState): Promise<void>;
};

export type LobsterApprovalResult = {
  approved: boolean;
  workflowStatus: string;
};

/**
 * Production boundary between Lobster's resumable approval and Guardian's
 * durable IncidentState. The caller owns the Lobster transport; this entry
 * owns every approval/remediation transition and persists each checkpoint
 * through the same Gateway session writer used by alert ingestion.
 */
export async function authorizeRemediationWithLobster(input: {
  sessionKey: string;
  approvalState: IncidentState;
  idempotencyKey: string;
  target: RemediationTarget;
  decidedAt: string;
  startedAt: string;
  writer: IncidentStateWriter;
  requestApproval: () => Promise<LobsterApprovalResult>;
}): Promise<{
  decision: "started" | "denied";
  state: IncidentState;
  workflowStatus: string;
}> {
  if (
    input.approvalState.stage !== "approval" ||
    input.approvalState.approvalStatus !== "pending"
  ) {
    throw new Error(
      "Lobster remediation entry requires a pending approval incident",
    );
  }

  await input.writer.persistIncidentState(
    input.sessionKey,
    input.approvalState,
  );

  const approval = await input.requestApproval();
  const decided = recordApprovalDecision(
    input.approvalState,
    approval.approved,
    input.decidedAt,
  );
  await input.writer.persistIncidentState(input.sessionKey, decided);

  if (!approval.approved) {
    return {
      decision: "denied",
      state: decided,
      workflowStatus: approval.workflowStatus,
    };
  }

  const started = beginRemediationAttempt(decided, {
    idempotencyKey: input.idempotencyKey,
    target: input.target,
    startedAt: input.startedAt,
  });
  if (started.decision !== "started") {
    throw new Error(
      `Lobster-approved remediation attempt did not start: ${started.decision}`,
    );
  }
  await input.writer.persistIncidentState(input.sessionKey, started.state);

  return {
    decision: "started",
    state: started.state,
    workflowStatus: approval.workflowStatus,
  };
}
