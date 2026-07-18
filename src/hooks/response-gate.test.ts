import { describe, expect, it } from "vitest";

import {
  buildProposalToolGateDecision,
  buildResponseGateDecision,
  recordGuardianToolObservation,
} from "./response-gate.js";

describe("Guardian before_agent_finalize response gate", () => {
  it("does not affect runs that never used Guardian", () => {
    expect(buildResponseGateDecision(undefined)).toBeUndefined();
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
});
