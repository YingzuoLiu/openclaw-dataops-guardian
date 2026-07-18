import { describe, expect, it } from "vitest";

import {
  activateGuardianRunEvidence,
  buildGuardianGateAuditEvent,
  buildProposalToolGateDecision,
  buildResponseGateDecision,
  recordGuardianToolObservation,
  shouldEnforceGuardianRequireTools,
} from "./response-gate.js";

describe("Guardian before_agent_finalize response gate", () => {
  it("does not affect runs that never used Guardian", () => {
    expect(buildResponseGateDecision(undefined)).toBeUndefined();
  });

  it("gates a dedicated Guardian run even when the model calls zero tools", () => {
    const state = activateGuardianRunEvidence(undefined);

    expect(buildResponseGateDecision(state)?.reason).toContain(
      "guardian_query_prometheus",
    );
    expect(buildResponseGateDecision(state)?.reason).toContain(
      "guardian_inspect_metric_snapshot",
    );
  });

  it("requires an explicit plugin config opt-in for run-wide enforcement", () => {
    expect(shouldEnforceGuardianRequireTools(undefined)).toBe(false);
    expect(
      shouldEnforceGuardianRequireTools({
        enforceRequireToolsOnAgentRuns: true,
      }),
    ).toBe(true);
  });

  it("requests one bounded revision when required tools are missing", () => {
    const state = recordGuardianToolObservation(undefined, {
      toolName: "guardian_query_prometheus",
      succeeded: true,
    });

    expect(buildResponseGateDecision(state)).toMatchObject({
      action: "revise",
      retry: {
        maxAttempts: 1,
      },
    });
    expect(buildResponseGateDecision(state)?.reason).toContain(
      "guardian_inspect_metric_snapshot",
    );
  });

  it("allows finalization after both evidence tools succeed", () => {
    let state = recordGuardianToolObservation(undefined, {
      toolName: "guardian_query_prometheus",
      succeeded: true,
    });
    state = recordGuardianToolObservation(state, {
      toolName: "guardian_inspect_metric_snapshot",
      succeeded: true,
    });

    expect(buildResponseGateDecision(state)).toBeUndefined();
  });

  it("does not count a failed tool call as evidence", () => {
    const state = recordGuardianToolObservation(undefined, {
      toolName: "guardian_query_prometheus",
      succeeded: false,
    });

    expect(buildResponseGateDecision(state)?.reason).toContain(
      "guardian_query_prometheus",
    );
  });

  it("blocks a remediation proposal until both evidence tools succeed", () => {
    let state = recordGuardianToolObservation(undefined, {
      toolName: "guardian_query_prometheus",
      succeeded: true,
    });
    expect(buildProposalToolGateDecision(state)?.blockReason).toContain(
      "guardian_inspect_metric_snapshot",
    );

    state = recordGuardianToolObservation(state, {
      toolName: "guardian_inspect_metric_snapshot",
      succeeded: true,
    });
    expect(buildProposalToolGateDecision(state)).toBeUndefined();
  });

  it("emits a sanitized structured audit record", () => {
    const state = recordGuardianToolObservation(
      activateGuardianRunEvidence(undefined),
      {
        toolName: "guardian_query_prometheus",
        succeeded: false,
      },
    );

    expect(
      buildGuardianGateAuditEvent({
        state,
        hook: "before_agent_finalize",
        runId: "run-123",
        decision: "revise",
        recordedAt: "2026-07-18T12:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: 1,
      component: "dataops-guardian",
      event: "require_tools",
      hook: "before_agent_finalize",
      runId: "run-123",
      decision: "revise",
      requiredTools: [
        "guardian_query_prometheus",
        "guardian_inspect_metric_snapshot",
      ],
      missingTools: [
        "guardian_query_prometheus",
        "guardian_inspect_metric_snapshot",
      ],
      attemptedButFailedTools: ["guardian_query_prometheus"],
      recordedAt: "2026-07-18T12:00:00.000Z",
    });
  });
});
