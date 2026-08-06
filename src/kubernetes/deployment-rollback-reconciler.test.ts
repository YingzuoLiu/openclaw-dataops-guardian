import { describe, expect, it } from "vitest";

import type { AppsV1Api, V1Deployment, V1PodTemplateSpec } from "@kubernetes/client-node";

import { resolveKubernetesToolConfig, type KubernetesDeploymentClient } from "./config.js";
import { KubernetesDeploymentRollbackReconciler } from "./deployment-rollback-reconciler.js";
import {
  hashIdempotencyKey,
  KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
  templateSha256,
} from "./deployment-rollback.js";

const config = resolveKubernetesToolConfig({
  kubernetes: {
    clusterId: "guardian-step3-kind",
    kubeconfigPath: "/etc/guardian/kubeconfig",
    allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
  },
});

const v1Template = {
  metadata: { labels: { app: "payments" } },
  spec: { containers: [{ name: "payments", image: "payments:v1" }] },
} as V1PodTemplateSpec;
const v1TemplateHash = templateSha256(v1Template);

const idempotencyKey = "guardian:k8s-rollback:v1:occurrence-1:deployment-uid-1:2:1:attempt-1";

const request = {
  idempotencyKey,
  target: {
    type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
    clusterId: "guardian-step3-kind",
    namespace: "guardian-step3",
    deployment: "payments-step3",
    deploymentUid: "deployment-uid-1",
    fromRevision: 2,
    toRevision: 1,
    fromTemplateSha256: "1".repeat(64),
    toTemplateSha256: v1TemplateHash,
  },
  startedAt: "2026-08-03T00:00:00.000Z",
};

function successfullyRolledBackDeployment(): V1Deployment {
  return {
    metadata: {
      uid: "deployment-uid-1",
      annotations: {
        [ROLLBACK_KEY_HASH_ANNOTATION]: hashIdempotencyKey(idempotencyKey),
        [ROLLBACK_FROM_REVISION_ANNOTATION]: "2",
        [ROLLBACK_TO_REVISION_ANNOTATION]: "1",
        [ROLLBACK_TEMPLATE_HASH_ANNOTATION]: v1TemplateHash,
      },
    },
    spec: { template: v1Template },
  } as unknown as V1Deployment;
}

function clientFactoryFor(deployment: V1Deployment | (() => Promise<V1Deployment>)) {
  return async (): Promise<KubernetesDeploymentClient> => ({
    apiServer: "https://127.0.0.1:6443/",
    api: {
      readNamespacedDeployment: async () =>
        typeof deployment === "function" ? await deployment() : deployment,
    } as unknown as AppsV1Api,
  });
}

describe("KubernetesDeploymentRollbackReconciler", () => {
  it("confirms success when UID, annotations, and live template all agree", async () => {
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(successfullyRolledBackDeployment()),
    );
    const result = await reconciler.reconcile(request);
    expect(result.outcome).toBe("confirmed_succeeded");
  });

  it("never returns confirmed_failed", async () => {
    // Simulate every kind of negative evidence and confirm none of them
    // resolve to a definite failure -- only confirmed_succeeded or unknown.
    const scenarios: Array<() => V1Deployment> = [
      () => ({ metadata: { uid: "different-uid" }, spec: { template: v1Template } } as V1Deployment),
      () => ({ metadata: { uid: "deployment-uid-1" } } as V1Deployment),
      () => {
        const deployment = successfullyRolledBackDeployment();
        deployment.metadata!.annotations = {};
        return deployment;
      },
    ];

    for (const scenario of scenarios) {
      const reconciler = new KubernetesDeploymentRollbackReconciler(
        config,
        clientFactoryFor(scenario()),
      );
      const result = await reconciler.reconcile(request);
      expect(result.outcome).not.toBe("confirmed_failed");
    }
  });

  it("returns unknown when the Deployment UID was recreated", async () => {
    const deployment = successfullyRolledBackDeployment();
    deployment.metadata!.uid = "recreated-uid";
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(deployment),
    );
    const result = await reconciler.reconcile(request);
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown when the fromRevision annotation does not match the target, even if everything else matches", async () => {
    const deployment = successfullyRolledBackDeployment();
    deployment.metadata!.annotations = {
      ...deployment.metadata!.annotations,
      [ROLLBACK_FROM_REVISION_ANNOTATION]: "99",
    };
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(deployment),
    );
    const result = await reconciler.reconcile(request);
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown when the audit annotations are absent", async () => {
    const deployment = successfullyRolledBackDeployment();
    deployment.metadata!.annotations = {};
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(deployment),
    );
    const result = await reconciler.reconcile(request);
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown when the live template digest no longer matches the recorded annotation", async () => {
    const deployment = successfullyRolledBackDeployment();
    deployment.spec = {
      template: {
        metadata: { labels: { app: "payments" } },
        spec: { containers: [{ name: "payments", image: "payments:v3-drift" }] },
      } as V1PodTemplateSpec,
    } as never;
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(deployment),
    );
    const result = await reconciler.reconcile(request);
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown when the Deployment cannot be read", async () => {
    const reconciler = new KubernetesDeploymentRollbackReconciler(config, async () => ({
      apiServer: "https://127.0.0.1:6443/",
      api: {
        readNamespacedDeployment: async () => {
          throw new Error("not found");
        },
      } as unknown as AppsV1Api,
    }));
    const result = await reconciler.reconcile(request);
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown for a target outside the allowlist without dispatching a rollback", async () => {
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(successfullyRolledBackDeployment()),
    );
    const result = await reconciler.reconcile({
      ...request,
      target: { ...request.target, namespace: "default", deployment: "other" },
    });
    expect(result.outcome).toBe("unknown");
  });

  it("returns unknown for a malformed target instead of throwing", async () => {
    const reconciler = new KubernetesDeploymentRollbackReconciler(
      config,
      clientFactoryFor(successfullyRolledBackDeployment()),
    );
    const result = await reconciler.reconcile({ ...request, target: { kind: "not_a_rollback_target" } });
    expect(result.outcome).toBe("unknown");
  });
});
