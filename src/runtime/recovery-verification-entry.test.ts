import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { DeploymentPrometheusRecoveryResult } from "../recovery/deployment-prometheus-recovery.js";
import { reduceAlertDelivery } from "../state/incident-reducer.js";
import type { IncidentState, RemediationTarget } from "../state/incident-state.js";
import {
  beginRemediationAttempt,
  finishRemediationAttempt,
} from "../state/incident-workflow.js";
import { persistDeploymentRecoveryVerification } from "./recovery-verification-entry.js";

const startedAt = "2026-08-07T00:00:00.000Z";
const finishedAt = "2026-08-07T00:00:01.000Z";
const checkedAt = "2026-08-07T00:00:03.000Z";
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

function stateInRecovery(): IncidentState {
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
  const started = beginRemediationAttempt(
    {
      ...created.state,
      stage: "remediation",
      approvalStatus: "approved",
    },
    { idempotencyKey, target, startedAt },
  );
  return finishRemediationAttempt(started.state, {
    idempotencyKey,
    status: "succeeded",
    finishedAt,
    error: null,
  }).state;
}

function result(): DeploymentPrometheusRecoveryResult {
  return {
    decision: "recovered",
    checkedAt,
    notBefore: finishedAt,
    target: target as never,
    deployment: {
      healthy: true,
      issues: [],
      namespace: "guardian-step4",
      deployment: "payments-step4",
      deploymentUid: "uid-1",
      generation: 3,
      observedGeneration: 3,
      desiredReplicas: 1,
      updatedReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
      templateSha256: "2".repeat(64),
    },
    prometheus: {
      healthy: true,
      issues: [],
      query: "payment_success_rate",
      comparator: "gte",
      threshold: 0.95,
      currentValue: 1,
      observedAt: "2026-08-07T00:00:02.000Z",
      labels: { service: "payments" },
    },
    summary: "Both recovery signals passed.",
  };
}

describe("persistDeploymentRecoveryVerification", () => {
  it("durably advances an exactly bound dual recovery result to completed", async () => {
    const persistIncidentState = vi.fn(async () => undefined);
    const completed = await persistDeploymentRecoveryVerification({
      sessionKey: "agent:main:step4",
      state: stateInRecovery(),
      idempotencyKey,
      target,
      result: result(),
      writer: { persistIncidentState },
    });

    expect(completed.stage).toBe("completed");
    expect(completed.evidence.at(-1)).toMatchObject({
      source: "guardian_deployment_prometheus_recovery",
      summary: "Both recovery signals passed.",
    });
    expect(persistIncidentState).toHaveBeenCalledWith(
      "agent:main:step4",
      completed,
    );
  });

  it("rejects a mismatched target or inconsistent aggregate decision without writing", async () => {
    const persistIncidentState = vi.fn(async () => undefined);
    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        state: stateInRecovery(),
        idempotencyKey,
        target: { ...target, deployment: "other" },
        result: result(),
        writer: { persistIncidentState },
      }),
    ).rejects.toThrow("target binding mismatch");

    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        state: stateInRecovery(),
        idempotencyKey,
        target,
        result: { ...result(), decision: "not_recovered" },
        writer: { persistIncidentState },
      }),
    ).rejects.toThrow("aggregate decision is inconsistent");
    expect(persistIncidentState).not.toHaveBeenCalled();
  });

  it("keeps the real proof on the gated Tool and production persistence entry", async () => {
    const proof = await readFile(
      new URL("../../scripts/kind-prometheus-recovery-rpc.mjs", import.meta.url),
      "utf8",
    );
    expect(proof).toContain('name: "guardian_verify_deployment_recovery"');
    expect(proof).toContain("persistDeploymentRecoveryVerification");
    expect(proof).not.toContain("recordRecoveryCheck");
    expect(proof).not.toContain('client.request("sessions.pluginPatch"');
  });
});
