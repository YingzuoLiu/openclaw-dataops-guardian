import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  requireRecoveryPolicy,
  resolveKubernetesToolConfig,
} from "../kubernetes/config.js";
import { decodeKubernetesDeploymentRollbackTarget } from "../kubernetes/deployment-rollback.js";
import { readIncidentStateV3 } from "../state/incident-state.js";
import { jsonValuesEqual } from "../state/incident-workflow.js";
import { resolvePrometheusToolConfig } from "../tools/query-prometheus.js";

export type VerifyDeploymentRecoveryGateDecision = {
  block: true;
  blockReason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Binds the read-only recovery proof to the exact rollback that has already
 * settled successfully. Callers cannot choose the target, evaluation start
 * time, Prometheus endpoint, query, threshold, or comparison policy.
 */
export function buildVerifyDeploymentRecoveryToolGateDecision(input: {
  incident: PluginJsonValue | undefined;
  toolParams: unknown;
  rawConfig: unknown;
}): VerifyDeploymentRecoveryGateDecision | undefined {
  if (input.incident === undefined) {
    return {
      block: true,
      blockReason:
        "guardian_verify_deployment_recovery requires persisted incident state",
    };
  }
  const decoded = readIncidentStateV3(input.incident);
  if (!decoded.ok) {
    return {
      block: true,
      blockReason: `guardian_verify_deployment_recovery cannot read incident state: ${decoded.error}`,
    };
  }
  const state = decoded.state;
  if (state.approvalStatus !== "approved") {
    return {
      block: true,
      blockReason:
        "guardian_verify_deployment_recovery requires an approved incident",
    };
  }
  if (state.stage !== "recovery_check") {
    return {
      block: true,
      blockReason: `guardian_verify_deployment_recovery requires stage=recovery_check (current stage: ${state.stage})`,
    };
  }

  const params = isRecord(input.toolParams) ? input.toolParams : undefined;
  const idempotencyKey = params?.idempotencyKey;
  const target = params?.target;
  const notBefore = params?.notBefore;
  const matchingAttempt =
    typeof idempotencyKey === "string"
      ? state.remediationAttempts.find(
          (attempt) => attempt.idempotencyKey === idempotencyKey,
        )
      : undefined;
  if (!matchingAttempt || matchingAttempt.status !== "succeeded") {
    return {
      block: true,
      blockReason:
        "guardian_verify_deployment_recovery idempotencyKey does not identify a succeeded remediation attempt",
    };
  }
  if (!isRecord(target) || !jsonValuesEqual(matchingAttempt.target, target)) {
    return {
      block: true,
      blockReason:
        "guardian_verify_deployment_recovery target does not match the succeeded remediation attempt",
    };
  }
  if (
    typeof notBefore !== "string" ||
    matchingAttempt.finishedAt === null ||
    notBefore !== matchingAttempt.finishedAt
  ) {
    return {
      block: true,
      blockReason:
        "guardian_verify_deployment_recovery notBefore must equal the succeeded attempt finishedAt",
    };
  }

  const rollbackTarget = decodeKubernetesDeploymentRollbackTarget(
    matchingAttempt.target,
  );
  if (!rollbackTarget) {
    return {
      block: true,
      blockReason:
        "guardian_verify_deployment_recovery attempt target is not a valid Kubernetes rollback target",
    };
  }

  try {
    const config = resolveKubernetesToolConfig(input.rawConfig);
    if (rollbackTarget.clusterId !== config.clusterId) {
      return {
        block: true,
        blockReason:
          "guardian_verify_deployment_recovery target clusterId does not match the configured cluster",
      };
    }
    requireRecoveryPolicy(
      config,
      rollbackTarget.namespace,
      rollbackTarget.deployment,
    );
    resolvePrometheusToolConfig(input.rawConfig);
  } catch (error) {
    return {
      block: true,
      blockReason: `guardian_verify_deployment_recovery configuration is invalid: ${(error as Error).message}`,
    };
  }

  return undefined;
}
