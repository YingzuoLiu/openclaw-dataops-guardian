import { jsonResult, type AnyAgentTool } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";

import {
  verifyDeploymentAndPrometheusRecovery,
  type RecoveryKubernetesClientFactory,
} from "../recovery/deployment-prometheus-recovery.js";
import type { RemediationTarget } from "../state/incident-state.js";
import { KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_SCHEMA } from "./rollback-deployment.js";

export const VERIFY_DEPLOYMENT_RECOVERY_TOOL_PARAMETERS = Type.Object(
  {
    idempotencyKey: Type.String({ minLength: 1, maxLength: 512 }),
    target: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_SCHEMA,
    notBefore: Type.String({ minLength: 1, maxLength: 64 }),
  },
  { additionalProperties: false },
);

export function createVerifyDeploymentRecoveryTool(
  rawConfig: unknown,
  kubernetesClientFactory?: RecoveryKubernetesClientFactory,
): AnyAgentTool {
  return {
    name: "guardian_verify_deployment_recovery",
    label: "Verify Deployment Recovery",
    description:
      "Read the allowlisted Deployment and administrator-configured Prometheus query, then verify both recovery signals against a completed rollback attempt.",
    parameters: VERIFY_DEPLOYMENT_RECOVERY_TOOL_PARAMETERS,
    execute: async (_toolCallId, rawParams) => {
      const params = rawParams as {
        idempotencyKey: string;
        target: RemediationTarget;
        notBefore: string;
      };
      return jsonResult(
        await verifyDeploymentAndPrometheusRecovery({
          rawConfig,
          idempotencyKey: params.idempotencyKey,
          target: params.target,
          notBefore: params.notBefore,
          ...(kubernetesClientFactory ? { kubernetesClientFactory } : {}),
        }),
      );
    },
  };
}
