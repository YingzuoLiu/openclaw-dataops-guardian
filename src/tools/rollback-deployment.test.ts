import { describe, expect, it, vi } from "vitest";

import type { AppsV1Api, V1Deployment, V1PodTemplateSpec } from "@kubernetes/client-node";

import {
  createRollbackDeploymentTool,
  executeRollbackDeployment,
} from "./rollback-deployment.js";
import {
  KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  templateSha256,
} from "../kubernetes/deployment-rollback.js";
import type { RemediationTarget } from "../state/incident-state.js";

const rawConfig = {
  kubernetes: {
    clusterId: "guardian-step3-kind",
    kubeconfigPath: "/etc/guardian/kubeconfig",
    allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
  },
};

const v1Template = {
  metadata: { labels: { app: "payments" } },
  spec: { containers: [{ name: "payments", image: "payments:v1" }] },
} as V1PodTemplateSpec;
const v2Template = {
  metadata: { labels: { app: "payments" } },
  spec: { containers: [{ name: "payments", image: "payments:v2" }] },
} as V1PodTemplateSpec;

const target: RemediationTarget = {
  type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  clusterId: "guardian-step3-kind",
  namespace: "guardian-step3",
  deployment: "payments-step3",
  deploymentUid: "deployment-uid-1",
  fromRevision: 2,
  toRevision: 1,
  fromTemplateSha256: templateSha256(v2Template),
  toTemplateSha256: templateSha256(v1Template),
};

function fakeClientFactory() {
  const deployment: V1Deployment = {
    metadata: {
      name: "payments-step3",
      namespace: "guardian-step3",
      uid: "deployment-uid-1",
      resourceVersion: "111",
      annotations: { "deployment.kubernetes.io/revision": "2" },
    },
    spec: { template: v2Template },
  } as unknown as V1Deployment;

  const api = {
    readNamespacedDeployment: async () => deployment,
    listNamespacedReplicaSet: async () => ({
      items: [
        {
          metadata: {
            annotations: { "deployment.kubernetes.io/revision": "1" },
            ownerReferences: [
              { apiVersion: "apps/v1", kind: "Deployment", name: "payments-step3", uid: "deployment-uid-1", controller: true },
            ],
          },
          spec: { template: v1Template },
        },
      ],
    }),
    patchNamespacedDeployment: async () => ({
      metadata: { ...deployment.metadata, resourceVersion: "112" },
    }),
  } as unknown as AppsV1Api;

  return async () => ({ api, apiServer: "https://127.0.0.1:6443/" });
}

describe("executeRollbackDeployment", () => {
  it("performs a rollback end to end through the injected client factory", async () => {
    const result = await executeRollbackDeployment({
      rawConfig,
      idempotencyKey: "attempt-key-1",
      target,
      clientFactory: fakeClientFactory(),
    });
    expect(result).toMatchObject({ decision: "rolled_back", toRevision: 1 });
  });

  it("throws on a malformed target instead of reaching Kubernetes", async () => {
    await expect(
      executeRollbackDeployment({
        rawConfig,
        idempotencyKey: "attempt-key-1",
        target: { kind: "not_a_rollback_target" },
        clientFactory: async () => {
          throw new Error("must not be called");
        },
      }),
    ).rejects.toThrow("malformed Kubernetes rollback target");
  });

  it("rejects a target outside the allowlist before ever creating a Kubernetes client", async () => {
    const clientFactory = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const outOfScopeTarget: RemediationTarget = {
      ...target,
      namespace: "default",
      deployment: "other-deployment",
    };
    await expect(
      executeRollbackDeployment({
        rawConfig,
        idempotencyKey: "attempt-key-1",
        target: outOfScopeTarget,
        clientFactory,
      }),
    ).rejects.toThrow("rejected by administrator allowlist");
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("throws when the administrator configuration is missing", async () => {
    await expect(
      executeRollbackDeployment({
        rawConfig: {},
        idempotencyKey: "attempt-key-1",
        target,
        clientFactory: fakeClientFactory(),
      }),
    ).rejects.toThrow("clusterId is required");
  });
});

describe("createRollbackDeploymentTool", () => {
  it("exposes the expected tool name and a strict parameter schema", () => {
    const tool = createRollbackDeploymentTool(rawConfig, fakeClientFactory());
    expect(tool.name).toBe("guardian_rollback_deployment");
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
    });
  });

  it("returns the rollback result as tool JSON output", async () => {
    const tool = createRollbackDeploymentTool(rawConfig, fakeClientFactory());
    const result = (await tool.execute?.("call-1", {
      idempotencyKey: "attempt-key-1",
      target,
    })) as { details?: unknown };
    expect(result?.details).toMatchObject({ decision: "rolled_back" });
  });
});
