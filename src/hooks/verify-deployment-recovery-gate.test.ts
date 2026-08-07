import { describe, expect, it } from "vitest";

import { reduceAlertDelivery } from "../state/incident-reducer.js";
import type { IncidentState, RemediationTarget } from "../state/incident-state.js";
import {
  beginRemediationAttempt,
  finishRemediationAttempt,
} from "../state/incident-workflow.js";
import { buildVerifyDeploymentRecoveryToolGateDecision } from "./verify-deployment-recovery-gate.js";

const startedAt = "2026-08-07T00:00:00.000Z";
const finishedAt = "2026-08-07T00:00:01.000Z";
const idempotencyKey = "attempt-1";
const target: RemediationTarget = {
  type: "kubernetes_deployment_rollback_v1",
  clusterId: "guardian-step4-kind",
  namespace: "guardian-step4",
  deployment: "payments-step4",
  deploymentUid: "uid-1",
  fromRevision: 2,
  toRevision: 1,
  fromTemplateSha256: "1".repeat(64),
  toTemplateSha256: "2".repeat(64),
};
const rawConfig = {
  prometheusBaseUrl: "http://127.0.0.1:19090",
  kubernetes: {
    clusterId: "guardian-step4-kind",
    kubeconfigPath: "/tmp/scoped-kubeconfig",
    allowlist: [
      {
        namespace: "guardian-step4",
        deployment: "payments-step4",
        recovery: {
          prometheusQuery: "payment_success_rate",
          comparator: "gte",
          threshold: 0.95,
          maxSampleAgeSeconds: 120,
        },
      },
    ],
  },
};

function recoveryState(): IncidentState {
  const created = reduceAlertDelivery(undefined, {
    alertId: "alert-1",
    fingerprint: "fingerprint-1",
    alertStatus: "firing",
    startsAt: startedAt,
    endsAt: null,
    receivedAt: startedAt,
    deliveryId: "delivery-1",
  });
  if (!created.state) throw new Error("fixture incident missing");
  const approved = {
    ...created.state,
    stage: "remediation" as const,
    approvalStatus: "approved" as const,
  };
  const started = beginRemediationAttempt(approved, {
    idempotencyKey,
    target,
    startedAt,
  });
  const finished = finishRemediationAttempt(started.state, {
    idempotencyKey,
    status: "succeeded",
    finishedAt,
    error: null,
  });
  return finished.state;
}

describe("buildVerifyDeploymentRecoveryToolGateDecision", () => {
  it("allows only the exact succeeded attempt binding", () => {
    expect(
      buildVerifyDeploymentRecoveryToolGateDecision({
        incident: recoveryState(),
        toolParams: { idempotencyKey, target, notBefore: finishedAt },
        rawConfig,
      }),
    ).toBeUndefined();
  });

  it("blocks the wrong stage, target, timestamp, or missing policy", () => {
    const state = recoveryState();
    expect(
      buildVerifyDeploymentRecoveryToolGateDecision({
        incident: { ...state, stage: "completed" },
        toolParams: { idempotencyKey, target, notBefore: finishedAt },
        rawConfig,
      })?.blockReason,
    ).toContain("requires stage=recovery_check");
    expect(
      buildVerifyDeploymentRecoveryToolGateDecision({
        incident: state,
        toolParams: {
          idempotencyKey,
          target: { ...target, deployment: "other" },
          notBefore: finishedAt,
        },
        rawConfig,
      })?.blockReason,
    ).toContain("target does not match");
    expect(
      buildVerifyDeploymentRecoveryToolGateDecision({
        incident: state,
        toolParams: { idempotencyKey, target, notBefore: startedAt },
        rawConfig,
      })?.blockReason,
    ).toContain("must equal");
    expect(
      buildVerifyDeploymentRecoveryToolGateDecision({
        incident: state,
        toolParams: { idempotencyKey, target, notBefore: finishedAt },
        rawConfig: {
          ...rawConfig,
          kubernetes: {
            ...rawConfig.kubernetes,
            allowlist: [{ namespace: "guardian-step4", deployment: "payments-step4" }],
          },
        },
      })?.blockReason,
    ).toContain("recovery policy is missing");
  });
});
