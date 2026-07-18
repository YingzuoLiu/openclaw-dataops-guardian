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
      source: "prometheus:payment_success_rate{service=\"payments\"}",
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
      evidenceValidation: { status: "passed", issues: [] },
      proposedAction: "rollback_latest_release",
      retryCount: 0,
    });
    expect(state.evidence).toHaveLength(4);
    expect(state.evidence[0]?.source).toBe(
      'prometheus:payment_success_rate{service="payments"}',
    );
  });

  it("blocks a denied remediation", () => {
    const at = "2026-07-18T00:00:00.000Z";
    const metric = inspectMetricSnapshot({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
      source: "prometheus:payment_success_rate",
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

  it("returns to evidence collection instead of approving unsupported evidence", () => {
    const at = "2026-07-18T00:00:00.000Z";
    const metric = inspectMetricSnapshot({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
      source: "supplied_snapshot",
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

    expect(state).toMatchObject({
      stage: "evidence_collection",
      proposedAction: null,
      approvalStatus: "not_requested",
      evidenceValidation: {
        status: "failed",
        issues: ["required evidence source is missing: prometheus:"],
      },
    });
  });

  it("blocks remediation after the hard recovery retry cap", () => {
    const at = "2026-07-18T00:00:00.000Z";
    const metric = inspectMetricSnapshot({
      alertId: "payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
      source: "prometheus:payment_success_rate",
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

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      state = recordRemediationExecution(state, `Attempt ${attempt}.`, at);
      state = recordRecoveryCheck(state, {
        healthy: false,
        summary: `Recovery check ${attempt} failed.`,
        checkedAt: at,
      });
    }

    expect(state).toMatchObject({
      stage: "blocked",
      retryCount: 3,
      approvalStatus: "approved",
    });
  });
});
