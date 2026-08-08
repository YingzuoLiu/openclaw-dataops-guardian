import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import type { DeploymentPrometheusRecoveryResult } from "../recovery/deployment-prometheus-recovery.js";
import {
  readIncidentStateV3,
  type IncidentState,
  type RemediationTarget,
} from "../state/incident-state.js";
import {
  jsonValuesEqual,
  recordRecoveryCheck,
} from "../state/incident-workflow.js";

export type RecoveryStateStore = {
  describeIncidentState(
    sessionKey: string,
  ): Promise<PluginJsonValue | undefined>;
  persistIncidentState(
    sessionKey: string,
    state: IncidentState,
  ): Promise<void>;
};

/**
 * Production persistence boundary for a recovery tool result. Trusted
 * Gateway/operator code is the only expected caller: it must supply the
 * genuine output of `verifyDeploymentAndPrometheusRecovery` (this boundary
 * checks internal binding/consistency, but never re-queries Kubernetes or
 * Prometheus itself).
 *
 * The current `IncidentState` is read from `store` immediately before both
 * validation and the write -- never from a snapshot the caller has been
 * holding across an external poll loop -- so a delivery replayed or
 * evidence appended by a concurrent flow (for example restart reconciliation
 * replaying a deferred Alertmanager delivery) while this recovery check was
 * in flight is preserved rather than silently overwritten. `store`'s
 * underlying write (`sessions.pluginPatch`) still has no compare-and-swap,
 * so this only closes the long stale-snapshot window this entry point would
 * otherwise invite; it does not provide full concurrency safety.
 */
export async function persistDeploymentRecoveryVerification(input: {
  sessionKey: string;
  idempotencyKey: string;
  target: RemediationTarget;
  result: DeploymentPrometheusRecoveryResult;
  store: RecoveryStateStore;
}): Promise<IncidentState> {
  const raw = await input.store.describeIncidentState(input.sessionKey);
  const decoded = readIncidentStateV3(raw);
  if (!decoded.ok) {
    throw new Error(
      `recovery verification cannot read incident state: ${decoded.error}`,
    );
  }
  const state = decoded.state;

  if (state.stage !== "recovery_check") {
    throw new Error("recovery verification requires stage=recovery_check");
  }
  const attempt = state.remediationAttempts.find(
    (candidate) => candidate.idempotencyKey === input.idempotencyKey,
  );
  if (
    !attempt ||
    attempt.status !== "succeeded" ||
    attempt.finishedAt === null
  ) {
    throw new Error("recovery verification requires a succeeded remediation attempt");
  }
  if (
    !jsonValuesEqual(attempt.target, input.target) ||
    !jsonValuesEqual(input.target, input.result.target)
  ) {
    throw new Error("recovery verification target binding mismatch");
  }
  if (input.result.notBefore !== attempt.finishedAt) {
    throw new Error("recovery verification notBefore binding mismatch");
  }
  if (Date.parse(input.result.checkedAt) < Date.parse(attempt.finishedAt)) {
    throw new Error("recovery verification predates remediation completion");
  }
  const recovered =
    input.result.deployment.healthy && input.result.prometheus.healthy;
  if (
    (input.result.decision === "recovered") !== recovered ||
    (input.result.decision === "not_recovered") === recovered
  ) {
    throw new Error("recovery verification aggregate decision is inconsistent");
  }

  const nextState = recordRecoveryCheck(state, {
    healthy: recovered,
    summary: input.result.summary,
    checkedAt: input.result.checkedAt,
    source: "guardian_deployment_prometheus_recovery",
  });
  await input.store.persistIncidentState(input.sessionKey, nextState);
  return nextState;
}
