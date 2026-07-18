import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

export type MetricSnapshotResult = {
  alertId: string;
  metric: string;
  currentValue: number;
  baselineValue: number;
  relativeChange: number | null;
  classification: "within_expected_range" | "warning" | "critical";
};

export function inspectMetricSnapshot(params: {
  alertId: string;
  metric: string;
  currentValue: number;
  baselineValue: number;
}): MetricSnapshotResult {
  const relativeChange =
    params.baselineValue === 0
      ? null
      : (params.currentValue - params.baselineValue) /
        Math.abs(params.baselineValue);
  const decline = relativeChange === null ? null : -relativeChange;

  const classification =
    decline !== null && decline + Number.EPSILON >= 0.2
      ? "critical"
      : decline !== null && decline + Number.EPSILON >= 0.05
        ? "warning"
        : "within_expected_range";

  return {
    alertId: params.alertId,
    metric: params.metric,
    currentValue: params.currentValue,
    baselineValue: params.baselineValue,
    relativeChange,
    classification,
  };
}

export function createInspectMetricSnapshotTool(): AnyAgentTool {
  return {
    name: "guardian_inspect_metric_snapshot",
    label: "Inspect Metric Snapshot",
    description:
      "Read-only compatibility tool that classifies a supplied metric snapshot against its baseline.",
    parameters: Type.Object(
      {
        alertId: Type.String({ minLength: 1 }),
        metric: Type.String({ minLength: 1 }),
        currentValue: Type.Number(),
        baselineValue: Type.Number(),
      },
      { additionalProperties: false },
    ),
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        alertId: string;
        metric: string;
        currentValue: number;
        baselineValue: number;
      };

      return jsonResult(inspectMetricSnapshot(params));
    },
  };
}
