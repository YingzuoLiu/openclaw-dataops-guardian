import { describe, expect, it } from "vitest";

import { inspectMetricSnapshot } from "../tools/inspect-metric-snapshot.js";
import { proposeRemediation } from "../tools/propose-remediation.js";
import {
  openIncident,
  recordApprovalDecision,
  recordMetricEvidence,
  recordRecoveryCheck,
  recordRemediationExecution,
  recordRemediationProposal,
} from "./incident-workflow.js";

describe("incident vertical slice reducer", () => {
  it("reaches completed after evidence, approval, remediation, and recovery", () => {
    const at = "2026-07-18T00:00:00.000Z";
    const metric = inspectMetricSnapshot({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
    });
    const proposal = proposeRemediation({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      classification: metric.classification,
    });

    let state = openIncident({
      alertId: "payment-success-rate-drop",
      occurredAt: at,
    });
    state = recordMetricEvidence(state, metric, at);
    state = recordRemediationProposal(state, proposal, at);
    state = recordApprovalDecision(state, true, at);
    state = recordRemediationExecution(state, "Rollback executed.", at);
    state = recordRecoveryCheck(state, {
      healthy: true,
      summary: "Payment success rate recovered.",
      checkedAt: at,
    });

    expect(state).toMatchObject({
      stage: "completed",
      approvalStatus: "approved",
      proposedAction: "rollback_latest_release",
      retryCount: 0,
    });
    expect(state.evidence).toHaveLength(4);
  });

  it("blocks a denied remediation", () => {
    const at = "2026-07-18T00:00:00.000Z";
    const metric = inspectMetricSnapshot({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
    });
    const proposal = proposeRemediation({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      classification: metric.classification,
    });
    let state = openIncident({
      alertId: "payment-success-rate-drop",
      occurredAt: at,
    });
    state = recordMetricEvidence(state, metric, at);
    state = recordRemediationProposal(state, proposal, at);

    expect(recordApprovalDecision(state, false, at)).toMatchObject({
      stage: "blocked",
      approvalStatus: "denied",
    });
  });
});
