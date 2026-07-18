import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

export type MetricClassification =
  | "within_expected_range"
  | "warning"
  | "critical";

export type RemediationProposal = {
  alertId: string;
  action: string;
  rationale: string;
  risk: "low" | "medium" | "high";
};

export function proposeRemediation(params: {
  alertId: string;
  metric: string;
  classification: MetricClassification;
}): RemediationProposal {
  if (params.classification === "critical") {
    return {
      alertId: params.alertId,
      action: "rollback_latest_release",
      rationale: `${params.metric} is critically below its baseline; roll back the latest release before recovery validation.`,
      risk: "high",
    };
  }

  if (params.classification === "warning") {
    return {
      alertId: params.alertId,
      action: "hold_deployments_and_increase_observation",
      rationale: `${params.metric} is degraded but not critical; freeze deployments and collect another observation window.`,
      risk: "medium",
    };
  }

  return {
    alertId: params.alertId,
    action: "no_change_continue_observation",
    rationale: `${params.metric} is within the expected range; no mutating remediation is justified.`,
    risk: "low",
  };
}

export function createProposeRemediationTool(): AnyAgentTool {
  return {
    name: "guardian_propose_remediation",
    label: "Propose Remediation",
    description:
      "Produce a deterministic remediation proposal from a classified metric alert. This tool does not execute the action.",
    parameters: Type.Object(
      {
        alertId: Type.String({ minLength: 1 }),
        metric: Type.String({ minLength: 1 }),
        classification: Type.Union([
          Type.Literal("within_expected_range"),
          Type.Literal("warning"),
          Type.Literal("critical"),
        ]),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) =>
      jsonResult(
        proposeRemediation(
          rawParams as {
            alertId: string;
            metric: string;
            classification: MetricClassification;
          },
        ),
      ),
  };
}
