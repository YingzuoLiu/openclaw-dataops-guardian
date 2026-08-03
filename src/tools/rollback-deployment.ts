import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import {
  assertAllowlistedTarget,
  createKubernetesDeploymentClient,
  resolveKubernetesToolConfig,
  type KubernetesDeploymentClient,
  type KubernetesToolConfig,
} from "../kubernetes/config.js";
import {
  decodeKubernetesDeploymentRollbackTarget,
  KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  performDeploymentRollback,
  type DeploymentRollbackResult,
} from "../kubernetes/deployment-rollback.js";
import type { RemediationTarget } from "../state/incident-state.js";

const KUBERNETES_NAME_PATTERN = "^[a-z0-9]([-a-z0-9]*[a-z0-9])?$";
const SHA256_HEX_PATTERN = "^[0-9a-f]{64}$";

const rollbackTargetSchema = Type.Object(
  {
    type: Type.Literal(KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE),
    clusterId: Type.String({ minLength: 1, maxLength: 253 }),
    namespace: Type.String({
      minLength: 1,
      maxLength: 63,
      pattern: KUBERNETES_NAME_PATTERN,
    }),
    deployment: Type.String({
      minLength: 1,
      maxLength: 253,
      pattern: KUBERNETES_NAME_PATTERN,
    }),
    deploymentUid: Type.String({ minLength: 1, maxLength: 128 }),
    fromRevision: Type.Integer({ minimum: 1 }),
    toRevision: Type.Integer({ minimum: 1 }),
    fromTemplateSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
    toTemplateSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
  },
  { additionalProperties: false },
);

export const ROLLBACK_DEPLOYMENT_TOOL_PARAMETERS = Type.Object(
  {
    idempotencyKey: Type.String({ minLength: 1, maxLength: 512 }),
    target: rollbackTargetSchema,
  },
  { additionalProperties: false },
);

export type RollbackDeploymentClientFactory = (
  config: KubernetesToolConfig,
) => Promise<KubernetesDeploymentClient>;

/**
 * Testable core of the tool: resolves config, builds a scoped Kubernetes
 * client, decodes the strict target, and performs (or safely no-ops) the
 * rollback. Kept separate from the AnyAgentTool wrapper so unit tests can
 * inject a fake clientFactory instead of reading a real kubeconfig.
 */
export async function executeRollbackDeployment(input: {
  rawConfig: unknown;
  idempotencyKey: string;
  target: RemediationTarget;
  clientFactory?: RollbackDeploymentClientFactory | undefined;
}): Promise<DeploymentRollbackResult> {
  const target = decodeKubernetesDeploymentRollbackTarget(input.target);
  if (!target) {
    throw new Error(
      "guardian_rollback_deployment received a malformed Kubernetes rollback target",
    );
  }

  const config = resolveKubernetesToolConfig(input.rawConfig);
  // Validated before any Kubernetes client is built, so an out-of-allowlist
  // or wrong-cluster target never causes a connection attempt.
  assertAllowlistedTarget(config, target.namespace, target.deployment);
  if (target.clusterId !== config.clusterId) {
    return {
      decision: "stale_target",
      reason: "target.clusterId does not match the configured Kubernetes cluster",
    };
  }

  const clientFactory = input.clientFactory ?? createKubernetesDeploymentClient;
  const { api } = await clientFactory(config);

  return performDeploymentRollback({
    config,
    api,
    idempotencyKey: input.idempotencyKey,
    target,
  });
}

export function createRollbackDeploymentTool(
  rawConfig: unknown,
  clientFactory?: RollbackDeploymentClientFactory,
): AnyAgentTool {
  return {
    name: "guardian_rollback_deployment",
    label: "Rollback Kubernetes Deployment",
    description:
      "Roll an administrator-allowlisted Kubernetes Deployment back to a specific prior PodTemplate revision. The idempotencyKey and target must exactly match a previously persisted, approved remediation attempt.",
    parameters: ROLLBACK_DEPLOYMENT_TOOL_PARAMETERS,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        idempotencyKey: string;
        target: RemediationTarget;
      };
      return jsonResult(
        await executeRollbackDeployment({
          rawConfig,
          idempotencyKey: params.idempotencyKey,
          target: params.target,
          clientFactory,
        }),
      );
    },
  };
}
