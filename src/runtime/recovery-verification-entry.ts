import type { DeploymentPrometheusRecoveryResult } from "../recovery/deployment-prometheus-recovery.js";
import type {
  IncidentState,
  RemediationTarget,
} from "../state/incident-state.js";
import {
  jsonValuesEqual,
  recordRecoveryCheck,
} from "../state/incident-workflow.js";

export type RecoveryStateWriter = {
  persistIncidentState(
    sessionKey: string,
    state: IncidentState,
  ): Promise<void>;
};

/**
 * Production persistence boundary for a recovery tool result. It rejects a
 * result that is not bound to the succeeded attempt or whose aggregate
 * decision disagrees with either underlying signal.
 */
export async function persistDeploymentRecoveryVerification(input: {
  sessionKey: string;
  state: IncidentState;
  idempotencyKey: string;
  target: RemediationTarget;
  result: DeploymentPrometheusRecoveryResult;
  writer: RecoveryStateWriter;
}): Promise<IncidentState> {
  if (input.state.stage !== "recovery_check") {
    throw new Error("recovery verification requires stage=recovery_check");
  }
  const attempt = input.state.remediationAttempts.find(
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

  const state = recordRecoveryCheck(input.state, {
    healthy: recovered,
    summary: input.result.summary,
    checkedAt: input.result.checkedAt,
    source: "guardian_deployment_prometheus_recovery",
  });
  await input.writer.persistIncidentState(input.sessionKey, state);
  return state;
}
