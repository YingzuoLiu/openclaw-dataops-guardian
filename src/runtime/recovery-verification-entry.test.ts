import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { DeploymentPrometheusRecoveryResult } from "../recovery/deployment-prometheus-recovery.js";
import { reduceAlertDelivery } from "../state/incident-reducer.js";
import type { IncidentState, RemediationTarget } from "../state/incident-state.js";
import {
  beginRemediationAttempt,
  finishRemediationAttempt,
  recordRecoveryCheck,
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

function storeReturning(state: IncidentState) {
  let current = state;
  return {
    describeIncidentState: vi.fn(async () => current as never),
    persistIncidentState: vi.fn(async (_sessionKey, nextState) => {
      current = nextState;
    }),
  };
}

describe("persistDeploymentRecoveryVerification", () => {
  it("durably advances an exactly bound dual recovery result to completed", async () => {
    const store = storeReturning(stateInRecovery());
    const completed = await persistDeploymentRecoveryVerification({
      sessionKey: "agent:main:step4",
      idempotencyKey,
      target,
      result: result(),
      store,
    });

    expect(store.describeIncidentState).toHaveBeenCalledWith("agent:main:step4");
    expect(store.describeIncidentState).toHaveBeenCalledTimes(2);
    expect(completed.stage).toBe("completed");
    expect(completed.evidence.at(-1)).toMatchObject({
      source: "guardian_deployment_prometheus_recovery",
      summary: "Both recovery signals passed.",
    });
    expect(store.persistIncidentState).toHaveBeenCalledWith(
      "agent:main:step4",
      completed,
    );
  });

  it("rejects a mismatched target or inconsistent aggregate decision without writing", async () => {
    const mismatchedTargetStore = storeReturning(stateInRecovery());
    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target: { ...target, deployment: "other" },
        result: result(),
        store: mismatchedTargetStore,
      }),
    ).rejects.toThrow("target binding mismatch");
    expect(mismatchedTargetStore.persistIncidentState).not.toHaveBeenCalled();

    const inconsistentDecisionStore = storeReturning(stateInRecovery());
    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: { ...result(), decision: "not_recovered" },
        store: inconsistentDecisionStore,
      }),
    ).rejects.toThrow("aggregate decision is inconsistent");
    expect(inconsistentDecisionStore.persistIncidentState).not.toHaveBeenCalled();
  });

  it("requires approved state and a valid non-stale checkedAt without writing", async () => {
    const nonApprovedStore = storeReturning({
      ...stateInRecovery(),
      approvalStatus: "denied",
    });
    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: result(),
        store: nonApprovedStore,
      }),
    ).rejects.toThrow("approvalStatus=approved");
    expect(nonApprovedStore.persistIncidentState).not.toHaveBeenCalled();

    for (const invalidCheckedAt of ["not-a-time", "2026-08-07"]) {
      const invalidTimeStore = storeReturning(stateInRecovery());
      await expect(
        persistDeploymentRecoveryVerification({
          sessionKey: "agent:main:step4",
          idempotencyKey,
          target,
          result: { ...result(), checkedAt: invalidCheckedAt },
          store: invalidTimeStore,
        }),
      ).rejects.toThrow("checkedAt must be a valid timestamp");
      expect(invalidTimeStore.persistIncidentState).not.toHaveBeenCalled();
    }

    const staleStore = storeReturning({
      ...stateInRecovery(),
      updatedAt: "2026-08-07T00:00:04.000Z",
    });
    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: result(),
        store: staleStore,
      }),
    ).rejects.toThrow("result is stale");
    expect(staleStore.persistIncidentState).not.toHaveBeenCalled();
  });

  it("binds recovery to the latest succeeded attempt", async () => {
    const firstAttemptState = stateInRecovery();
    const secondKey = "attempt-2";
    const secondTarget = { ...target, fromRevision: 3, toRevision: 2 };
    const restarted = beginRemediationAttempt(
      { ...firstAttemptState, stage: "remediation" },
      {
        idempotencyKey: secondKey,
        target: secondTarget,
        startedAt: "2026-08-07T00:00:02.000Z",
      },
    );
    const latestState = finishRemediationAttempt(restarted.state, {
      idempotencyKey: secondKey,
      status: "succeeded",
      finishedAt: "2026-08-07T00:00:03.000Z",
      error: null,
    }).state;
    const store = storeReturning(latestState);

    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: result(),
        store,
      }),
    ).rejects.toThrow("latest succeeded remediation attempt");
    expect(store.persistIncidentState).not.toHaveBeenCalled();

    const latestResult = {
      ...result(),
      checkedAt: "2026-08-07T00:00:04.000Z",
      notBefore: "2026-08-07T00:00:03.000Z",
      target: secondTarget as never,
    };
    const completed = await persistDeploymentRecoveryVerification({
      sessionKey: "agent:main:step4",
      idempotencyKey: secondKey,
      target: secondTarget,
      result: latestResult,
      store,
    });

    expect(completed.stage).toBe("completed");
    expect(store.persistIncidentState).toHaveBeenCalledWith(
      "agent:main:step4",
      completed,
    );
  });

  it("persists a consistent not_recovered result only to remediation", async () => {
    const store = storeReturning(stateInRecovery());
    const unhealthy = result();
    unhealthy.decision = "not_recovered";
    unhealthy.deployment = {
      ...unhealthy.deployment,
      healthy: false,
      issues: ["desired_replicas_not_positive"],
      desiredReplicas: 0,
      updatedReplicas: 0,
      availableReplicas: 0,
    };

    const next = await persistDeploymentRecoveryVerification({
      sessionKey: "agent:main:step4",
      idempotencyKey,
      target,
      result: unhealthy,
      store,
    });

    expect(next.stage).toBe("remediation");
    expect(next.stage).not.toBe("completed");
    expect(store.persistIncidentState).toHaveBeenCalledWith(
      "agent:main:step4",
      next,
    );
  });

  it("blocks a consistent not_recovered result when the retry budget is exhausted", async () => {
    let exhausted = recordRecoveryCheck(stateInRecovery(), {
      healthy: false,
      summary: "First recovery check failed.",
      checkedAt: "2026-08-07T00:00:02.000Z",
    });

    for (const attempt of [
      {
        idempotencyKey: "attempt-2",
        startedAt: "2026-08-07T00:00:03.000Z",
        finishedAt: "2026-08-07T00:00:04.000Z",
        checkedAt: "2026-08-07T00:00:05.000Z",
      },
      {
        idempotencyKey: "attempt-3",
        startedAt: "2026-08-07T00:00:06.000Z",
        finishedAt: "2026-08-07T00:00:07.000Z",
        checkedAt: "2026-08-07T00:00:08.000Z",
      },
    ]) {
      exhausted = beginRemediationAttempt(exhausted, {
        idempotencyKey: attempt.idempotencyKey,
        target,
        startedAt: attempt.startedAt,
      }).state;
      exhausted = finishRemediationAttempt(exhausted, {
        idempotencyKey: attempt.idempotencyKey,
        status: "succeeded",
        finishedAt: attempt.finishedAt,
        error: null,
      }).state;
      if (attempt.idempotencyKey === "attempt-2") {
        exhausted = recordRecoveryCheck(exhausted, {
          healthy: false,
          summary: "Second recovery check failed.",
          checkedAt: attempt.checkedAt,
        });
      }
    }

    const store = storeReturning(exhausted);
    const unhealthy = result();
    unhealthy.decision = "not_recovered";
    unhealthy.checkedAt = "2026-08-07T00:00:08.000Z";
    unhealthy.notBefore = "2026-08-07T00:00:07.000Z";
    unhealthy.deployment = {
      ...unhealthy.deployment,
      healthy: false,
      issues: ["desired_replicas_not_positive"],
      desiredReplicas: 0,
      updatedReplicas: 0,
      availableReplicas: 0,
    };

    const blocked = await persistDeploymentRecoveryVerification({
      sessionKey: "agent:main:step4",
      idempotencyKey: "attempt-3",
      target,
      result: unhealthy,
      store,
    });

    expect(blocked.stage).toBe("blocked");
    expect(blocked.stage).not.toBe("completed");
    expect(store.persistIncidentState).toHaveBeenCalledWith(
      "agent:main:step4",
      blocked,
    );
  });

  it("binds against the store's current state, not a snapshot the caller held during a poll", async () => {
    // Simulates a caller that read state once before starting a (potentially
    // long) external poll loop for guardian_verify_deployment_recovery to
    // converge. While polling, a concurrent flow (e.g. restart reconciliation
    // replaying a deferred Alertmanager delivery) appends new evidence to the
    // *durably persisted* state. The stale in-memory snapshot below is never
    // passed to persistDeploymentRecoveryVerification -- it exists only to
    // prove the concurrent evidence is not in it.
    const staleSnapshotBeforePoll = stateInRecovery();
    const concurrentEvidenceEntry = {
      source: "alertmanager_delivery",
      observedAt: "2026-08-07T00:00:02.000Z",
      summary: "A deferred Alertmanager delivery was replayed after restart.",
    };
    expect(staleSnapshotBeforePoll.evidence).not.toContainEqual(
      concurrentEvidenceEntry,
    );

    const latestDurableState: IncidentState = {
      ...staleSnapshotBeforePoll,
      evidence: [...staleSnapshotBeforePoll.evidence, concurrentEvidenceEntry],
      updatedAt: "2026-08-07T00:00:02.000Z",
    };
    const store = storeReturning(latestDurableState);

    const completed = await persistDeploymentRecoveryVerification({
      sessionKey: "agent:main:step4",
      idempotencyKey,
      target,
      result: result(),
      store,
    });

    expect(store.describeIncidentState).toHaveBeenCalledWith("agent:main:step4");
    expect(completed.stage).toBe("completed");
    expect(completed.evidence).toContainEqual(concurrentEvidenceEntry);
    expect(completed.evidence.at(-1)).toMatchObject({
      source: "guardian_deployment_prometheus_recovery",
    });
    expect(store.persistIncidentState).toHaveBeenCalledWith(
      "agent:main:step4",
      completed,
    );
  });

  it("rejects state that cannot be decoded from the store", async () => {
    const store = {
      describeIncidentState: vi.fn(async () => undefined),
      persistIncidentState: vi.fn(async () => undefined),
    };
    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: result(),
        store,
      }),
    ).rejects.toThrow("recovery verification cannot read incident state");
    expect(store.persistIncidentState).not.toHaveBeenCalled();
  });

  it("does not release completion when the persisted state cannot be read back", async () => {
    let reads = 0;
    const store = {
      describeIncidentState: vi.fn(async () => {
        reads += 1;
        return reads === 1 ? (stateInRecovery() as never) : undefined;
      }),
      persistIncidentState: vi.fn(async () => undefined),
    };

    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: result(),
        store,
      }),
    ).rejects.toThrow("cannot confirm persisted state: missing_state");
    expect(store.persistIncidentState).toHaveBeenCalledOnce();
    expect(store.describeIncidentState).toHaveBeenCalledTimes(2);
  });

  it("does not release completion when readback returns a stale state", async () => {
    const stale = stateInRecovery();
    const store = {
      describeIncidentState: vi.fn(async () => stale as never),
      persistIncidentState: vi.fn(async () => undefined),
    };

    await expect(
      persistDeploymentRecoveryVerification({
        sessionKey: "agent:main:step4",
        idempotencyKey,
        target,
        result: result(),
        store,
      }),
    ).rejects.toThrow("persisted state readback mismatch");
    expect(store.persistIncidentState).toHaveBeenCalledOnce();
    expect(store.describeIncidentState).toHaveBeenCalledTimes(2);
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
