import { describe, expect, it } from "vitest";

import { inspectMetricSnapshot } from "../tools/inspect-metric-snapshot.js";
import { proposeRemediation } from "../tools/propose-remediation.js";
import { reduceAlertDelivery } from "../state/incident-reducer.js";
import {
  beginRemediationAttempt,
  recordApprovalDecision,
  recordMetricEvidence,
  recordRemediationProposal,
} from "../state/incident-workflow.js";
import type { IncidentState, RemediationTarget } from "../state/incident-state.js";
import {
  KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  templateSha256,
} from "../kubernetes/deployment-rollback.js";
import { buildRollbackDeploymentToolGateDecision } from "./rollback-deployment-gate.js";

const at = "2026-08-03T00:00:00.000Z";

const rawConfig = {
  kubernetes: {
    clusterId: "guardian-step3-kind",
    kubeconfigPath: "/etc/guardian/kubeconfig",
    allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
  },
};

const v1TemplateHash = templateSha256({
  metadata: { labels: {} },
  spec: { containers: [{ name: "payments", image: "payments:v1" }] },
} as never);
const v2TemplateHash = templateSha256({
  metadata: { labels: {} },
  spec: { containers: [{ name: "payments", image: "payments:v2" }] },
} as never);

const rollbackTarget: RemediationTarget = {
  type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  clusterId: "guardian-step3-kind",
  namespace: "guardian-step3",
  deployment: "payments-step3",
  deploymentUid: "deployment-uid-1",
  fromRevision: 2,
  toRevision: 1,
  fromTemplateSha256: v2TemplateHash,
  toTemplateSha256: v1TemplateHash,
};

function approvedIncident(): IncidentState {
  const created = reduceAlertDelivery(undefined, {
    alertId: "payment-success-rate-drop",
    fingerprint: "alert-fingerprint",
    alertStatus: "firing",
    startsAt: at,
    endsAt: null,
    receivedAt: at,
    deliveryId: "delivery-1",
  });
  if (!created.state) {
    throw new Error("fixture incident was not created");
  }
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

  let state = created.state;
  state = recordMetricEvidence(state, metric, at);
  state = recordRemediationProposal(state, proposal, at);
  return recordApprovalDecision(state, true, at);
}

function withRunningAttempt(): { state: IncidentState; idempotencyKey: string } {
  const idempotencyKey = "guardian:k8s-rollback:v1:occurrence-1:deployment-uid-1:2:1:attempt-1";
  const started = beginRemediationAttempt(approvedIncident(), {
    idempotencyKey,
    target: rollbackTarget,
    startedAt: at,
  });
  if (started.decision !== "started") {
    throw new Error(`fixture attempt did not start: ${started.decision}`);
  }
  return { state: started.state, idempotencyKey };
}

describe("buildRollbackDeploymentToolGateDecision", () => {
  it("allows a call that exactly matches the persisted running attempt and allowlist", () => {
    const { state, idempotencyKey } = withRunningAttempt();
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: state,
      toolParams: { idempotencyKey, target: rollbackTarget },
      rawConfig,
    });
    expect(decision).toBeUndefined();
  });

  it("blocks when there is no incident state", () => {
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: undefined,
      toolParams: {},
      rawConfig,
    });
    expect(decision).toMatchObject({ block: true });
  });

  it("blocks an unsupported/invalid incident schema", () => {
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: { schemaVersion: 2 },
      toolParams: {},
      rawConfig,
    });
    expect(decision?.blockReason).toContain("cannot read incident state");
  });

  it("blocks when the incident is not approved", () => {
    // A realistic not-yet-approved incident: evidence and proposal recorded,
    // but recordApprovalDecision has not run, so there is no running attempt.
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
    const created = reduceAlertDelivery(undefined, {
      alertId: "payment-success-rate-drop",
      fingerprint: "alert-fingerprint",
      alertStatus: "firing",
      startsAt: at,
      endsAt: null,
      receivedAt: at,
      deliveryId: "delivery-1",
    });
    if (!created.state) {
      throw new Error("fixture incident was not created");
    }
    let pending = recordMetricEvidence(created.state, metric, at);
    pending = recordRemediationProposal(pending, proposal, at);
    expect(pending.approvalStatus).toBe("pending");

    const decision = buildRollbackDeploymentToolGateDecision({
      incident: pending,
      toolParams: { idempotencyKey: "attempt-1", target: rollbackTarget },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("requires an approved incident");
  });

  it("blocks when stage is not remediation", () => {
    const { state, idempotencyKey } = withRunningAttempt();
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: { ...state, stage: "blocked" },
      toolParams: { idempotencyKey, target: rollbackTarget },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("requires stage=remediation");
  });

  it("blocks when there is no running attempt", () => {
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: approvedIncident(),
      toolParams: { idempotencyKey: "attempt-1", target: rollbackTarget },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("exactly one running remediation attempt");
  });

  it("blocks when the call's idempotencyKey does not match the running attempt", () => {
    const { state } = withRunningAttempt();
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: state,
      toolParams: { idempotencyKey: "wrong-key", target: rollbackTarget },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("idempotencyKey does not match");
  });

  it("blocks when the call's target does not match the running attempt's target", () => {
    const { state, idempotencyKey } = withRunningAttempt();
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: state,
      toolParams: {
        idempotencyKey,
        target: { ...rollbackTarget, toRevision: 999 },
      },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("target does not match");
  });

  it("blocks when the persisted target does not decode as a Kubernetes rollback target", () => {
    const idempotencyKey = "attempt-1";
    const started = beginRemediationAttempt(approvedIncident(), {
      idempotencyKey,
      target: { kind: "synthetic" },
      startedAt: at,
    });
    if (started.decision !== "started") {
      throw new Error("fixture attempt did not start");
    }
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: started.state,
      toolParams: { idempotencyKey, target: { kind: "synthetic" } },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("not a valid Kubernetes rollback target");
  });

  it("blocks when target.clusterId does not match the configured cluster", () => {
    const idempotencyKey = "attempt-1";
    const mismatchedTarget = { ...rollbackTarget, clusterId: "some-other-cluster" };
    const started = beginRemediationAttempt(approvedIncident(), {
      idempotencyKey,
      target: mismatchedTarget,
      startedAt: at,
    });
    if (started.decision !== "started") {
      throw new Error("fixture attempt did not start");
    }
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: started.state,
      toolParams: { idempotencyKey, target: mismatchedTarget },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("clusterId does not match");
  });

  it("blocks a target outside the administrator allowlist", () => {
    const idempotencyKey = "attempt-1";
    const outOfScopeTarget = {
      ...rollbackTarget,
      namespace: "default",
      deployment: "other-deployment",
    };
    const started = beginRemediationAttempt(approvedIncident(), {
      idempotencyKey,
      target: outOfScopeTarget,
      startedAt: at,
    });
    if (started.decision !== "started") {
      throw new Error("fixture attempt did not start");
    }
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: started.state,
      toolParams: { idempotencyKey, target: outOfScopeTarget },
      rawConfig,
    });
    expect(decision?.blockReason).toContain("outside the administrator allowlist");
  });

  it("blocks when the Kubernetes configuration itself is invalid", () => {
    const { state, idempotencyKey } = withRunningAttempt();
    const decision = buildRollbackDeploymentToolGateDecision({
      incident: state,
      toolParams: { idempotencyKey, target: rollbackTarget },
      rawConfig: {},
    });
    expect(decision?.blockReason).toContain("Kubernetes configuration is invalid");
  });
});
