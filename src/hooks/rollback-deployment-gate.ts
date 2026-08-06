import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  isAllowlistedTarget,
  resolveKubernetesToolConfig,
} from "../kubernetes/config.js";
import { decodeKubernetesDeploymentRollbackTarget } from "../kubernetes/deployment-rollback.js";
import { readIncidentStateV3 } from "../state/incident-state.js";
import { jsonValuesEqual } from "../state/incident-workflow.js";

export type RollbackDeploymentGateDecision = {
  block: true;
  blockReason: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Gates guardian_rollback_deployment before it ever reaches Kubernetes. This
 * enforces the same running-attempt binding as every other remediation path
 * (approved + stage=remediation + exactly one running attempt whose key and
 * target exactly match the call) plus the administrator allowlist -- so the
 * mutating tool can only ever replay a state transition that was already
 * durably persisted, never originate one of its own.
 */
export function buildRollbackDeploymentToolGateDecision(input: {
  incident: PluginJsonValue | undefined;
  toolParams: unknown;
  rawConfig: unknown;
}): RollbackDeploymentGateDecision | undefined {
  if (input.incident === undefined) {
    return {
      block: true,
      blockReason: "guardian_rollback_deployment requires persisted incident state",
    };
  }
  const decoded = readIncidentStateV3(input.incident);
  if (!decoded.ok) {
    return {
      block: true,
      blockReason: `guardian_rollback_deployment cannot read incident state: ${decoded.error}`,
    };
  }
  const state = decoded.state;

  if (state.approvalStatus !== "approved") {
    return {
      block: true,
      blockReason: "guardian_rollback_deployment requires an approved incident",
    };
  }
  if (state.stage !== "remediation") {
    return {
      block: true,
      blockReason: `guardian_rollback_deployment requires stage=remediation (current stage: ${state.stage})`,
    };
  }

  const runningAttempts = state.remediationAttempts.filter(
    (attempt) => attempt.status === "running",
  );
  if (runningAttempts.length !== 1) {
    return {
      block: true,
      blockReason: `guardian_rollback_deployment requires exactly one running remediation attempt (found ${runningAttempts.length})`,
    };
  }
  const running = runningAttempts[0]!;

  const toolParams = isRecord(input.toolParams) ? input.toolParams : undefined;
  const idempotencyKey = toolParams?.idempotencyKey;
  const target = toolParams?.target;
  if (typeof idempotencyKey !== "string" || idempotencyKey !== running.idempotencyKey) {
    return {
      block: true,
      blockReason:
        "guardian_rollback_deployment idempotencyKey does not match the running remediation attempt",
    };
  }
  if (!isRecord(target) || !jsonValuesEqual(running.target, target)) {
    return {
      block: true,
      blockReason:
        "guardian_rollback_deployment target does not match the running remediation attempt",
    };
  }

  const decodedTarget = decodeKubernetesDeploymentRollbackTarget(running.target);
  if (!decodedTarget) {
    return {
      block: true,
      blockReason:
        "guardian_rollback_deployment running attempt target is not a valid Kubernetes rollback target",
    };
  }

  let config;
  try {
    config = resolveKubernetesToolConfig(input.rawConfig);
  } catch (error) {
    return {
      block: true,
      blockReason: `guardian_rollback_deployment Kubernetes configuration is invalid: ${(error as Error).message}`,
    };
  }
  if (decodedTarget.clusterId !== config.clusterId) {
    return {
      block: true,
      blockReason:
        "guardian_rollback_deployment target clusterId does not match the configured cluster",
    };
  }
  if (!isAllowlistedTarget(config, decodedTarget.namespace, decodedTarget.deployment)) {
    return {
      block: true,
      blockReason: `guardian_rollback_deployment target is outside the administrator allowlist: ${decodedTarget.namespace}/${decodedTarget.deployment}`,
    };
  }

  return undefined;
}
