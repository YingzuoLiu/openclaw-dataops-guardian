import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

export const INCIDENT_STATE_NAMESPACE = "incident";

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

export type IncidentState = {
  schemaVersion: 2;
  alertId: string;
  stage: IncidentStage;
  evidence: Array<{
    source: string;
    observedAt: string;
    summary: string;
  }>;
  proposedAction: string | null;
  approvalStatus: "not_requested" | "pending" | "approved" | "denied";
  evidenceValidation: {
    status: "not_checked" | "passed" | "failed";
    checkedAt: string | null;
    issues: string[];
  };
  retryCount: number;
  updatedAt: string;
};

export const MAX_REMEDIATION_RETRIES = 2;

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
