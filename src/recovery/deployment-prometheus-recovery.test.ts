import { describe, expect, it, vi } from "vitest";

import {
  hashIdempotencyKey,
  KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
  templateSha256,
  type KubernetesDeploymentRollbackTarget,
} from "../kubernetes/deployment-rollback.js";
import {
  inspectDeploymentRecovery,
  inspectPrometheusRecovery,
  verifyDeploymentAndPrometheusRecovery,
} from "./deployment-prometheus-recovery.js";

const idempotencyKey = "guardian:rollback:attempt-1";
const healthyTemplate = {
  metadata: { labels: { app: "payments" } },
  spec: { containers: [{ name: "payments", image: "payments:v1" }] },
};
const target: KubernetesDeploymentRollbackTarget = {
  type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  clusterId: "guardian-step4-kind",
  namespace: "guardian-step4",
  deployment: "payments-step4",
  deploymentUid: "uid-1",
  fromRevision: 2,
  toRevision: 1,
  fromTemplateSha256: "1".repeat(64),
  toTemplateSha256: templateSha256(healthyTemplate as never),
};

function deployment(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      uid: target.deploymentUid,
      generation: 3,
      annotations: {
        [ROLLBACK_KEY_HASH_ANNOTATION]: hashIdempotencyKey(idempotencyKey),
        [ROLLBACK_FROM_REVISION_ANNOTATION]: "2",
        [ROLLBACK_TO_REVISION_ANNOTATION]: "1",
        [ROLLBACK_TEMPLATE_HASH_ANNOTATION]: target.toTemplateSha256,
      },
    },
    spec: { replicas: 1, template: healthyTemplate },
    status: {
      observedGeneration: 3,
      updatedReplicas: 1,
      availableReplicas: 1,
      unavailableReplicas: 0,
    },
    ...overrides,
  } as never;
}

const policy = {
  prometheusQuery:
    'payment_success_rate{service="payments",environment="proof"}',
  comparator: "gte" as const,
  threshold: 0.95,
  maxSampleAgeSeconds: 120,
};

describe("dual recovery observations", () => {
  it("accepts an audited, converged Deployment and a fresh passing sample", () => {
    expect(inspectDeploymentRecovery(deployment(), target, idempotencyKey)).toMatchObject({
      healthy: true,
      issues: [],
      desiredReplicas: 1,
      availableReplicas: 1,
    });
    expect(
      inspectPrometheusRecovery(
        {
          query: policy.prometheusQuery,
          currentValue: 1,
          observedAt: "2026-08-07T00:00:02.000Z",
          labels: { service: "payments" },
        },
        policy,
        {
          notBefore: "2026-08-07T00:00:01.000Z",
          checkedAt: "2026-08-07T00:00:03.000Z",
        },
      ),
    ).toMatchObject({ healthy: true, issues: [] });
  });

  it("reports Deployment audit/readiness and Prometheus threshold failures deterministically", () => {
    const broken = deployment({
      metadata: { uid: "recreated-uid", generation: 4, annotations: {} },
      status: { observedGeneration: 3, availableReplicas: 0 },
    });
    expect(
      inspectDeploymentRecovery(broken, target, idempotencyKey).issues,
    ).toEqual(
      expect.arrayContaining([
        "deployment_uid_mismatch",
        "rollback_key_audit_mismatch",
        "deployment_generation_not_observed",
        "deployment_replicas_not_ready",
      ]),
    );
    expect(
      inspectPrometheusRecovery(
        {
          query: policy.prometheusQuery,
          currentValue: 0.7,
          observedAt: "2026-08-07T00:00:02.000Z",
          labels: {},
        },
        policy,
        {
          notBefore: "2026-08-07T00:00:01.000Z",
          checkedAt: "2026-08-07T00:00:03.000Z",
        },
      ).issues,
    ).toContain("prometheus_threshold_not_met");
  });

  it("rejects a passing sample captured before remediation completed", () => {
    expect(
      inspectPrometheusRecovery(
        {
          query: policy.prometheusQuery,
          currentValue: 1,
          observedAt: "2026-08-07T00:00:00.000Z",
          labels: {},
        },
        policy,
        {
          notBefore: "2026-08-07T00:00:01.000Z",
          checkedAt: "2026-08-07T00:00:03.000Z",
        },
      ).issues,
    ).toContain("prometheus_sample_precedes_remediation");
  });
});

function baseRawConfig(overrides: Record<string, unknown> = {}) {
  return {
    prometheusBaseUrl: "http://127.0.0.1:19090",
    kubernetes: {
      clusterId: target.clusterId,
      kubeconfigPath: "/tmp/scoped-kubeconfig",
      allowlist: [
        {
          namespace: target.namespace,
          deployment: target.deployment,
          recovery: policy,
        },
      ],
    },
    ...overrides,
  };
}

function passingPrometheusFetch() {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        status: "success",
        data: {
          resultType: "vector",
          result: [
            {
              metric: { service: "payments" },
              value: [Date.parse("2026-08-07T00:00:02.000Z") / 1_000, "1"],
            },
          ],
        },
      }),
    ),
  );
}

describe("verifyDeploymentAndPrometheusRecovery", () => {
  it("reads both systems and returns recovered only when both pass", async () => {
    const readNamespacedDeployment = vi.fn(async () => deployment());
    const prometheusFetch = passingPrometheusFetch();
    const result = await verifyDeploymentAndPrometheusRecovery({
      rawConfig: baseRawConfig(),
      idempotencyKey,
      target,
      notBefore: "2026-08-07T00:00:01.000Z",
      checkedAt: "2026-08-07T00:00:03.000Z",
      kubernetesClientFactory: async () => ({
        api: { readNamespacedDeployment } as never,
        apiServer: "https://127.0.0.1:6443/",
      }),
      prometheusFetch,
    });

    expect(result).toMatchObject({
      decision: "recovered",
      deployment: { healthy: true },
      prometheus: { healthy: true, currentValue: 1, threshold: 0.95 },
    });
    expect(readNamespacedDeployment).toHaveBeenCalledWith({
      namespace: target.namespace,
      name: target.deployment,
    });
    expect(prometheusFetch).toHaveBeenCalledOnce();
  });

  it("rejects a target clusterId that does not match the configured cluster without touching either live system", async () => {
    const kubernetesClientFactory = vi.fn(async () => ({
      api: { readNamespacedDeployment: vi.fn() } as never,
      apiServer: "https://127.0.0.1:6443/",
    }));
    const prometheusFetch = passingPrometheusFetch();

    await expect(
      verifyDeploymentAndPrometheusRecovery({
        rawConfig: baseRawConfig({
          kubernetes: {
            clusterId: "a-different-cluster",
            kubeconfigPath: "/tmp/scoped-kubeconfig",
            allowlist: [
              {
                namespace: target.namespace,
                deployment: target.deployment,
                recovery: policy,
              },
            ],
          },
        }),
        idempotencyKey,
        target,
        notBefore: "2026-08-07T00:00:01.000Z",
        checkedAt: "2026-08-07T00:00:03.000Z",
        kubernetesClientFactory,
        prometheusFetch,
      }),
    ).rejects.toThrow("clusterId does not match configured cluster");

    expect(kubernetesClientFactory).not.toHaveBeenCalled();
    expect(prometheusFetch).not.toHaveBeenCalled();
  });

  it("rejects a target that cannot be decoded as a Kubernetes rollback target", async () => {
    const kubernetesClientFactory = vi.fn(async () => ({
      api: { readNamespacedDeployment: vi.fn() } as never,
      apiServer: "https://127.0.0.1:6443/",
    }));
    const prometheusFetch = passingPrometheusFetch();

    await expect(
      verifyDeploymentAndPrometheusRecovery({
        rawConfig: baseRawConfig(),
        idempotencyKey,
        target: { type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE } as never,
        notBefore: "2026-08-07T00:00:01.000Z",
        checkedAt: "2026-08-07T00:00:03.000Z",
        kubernetesClientFactory,
        prometheusFetch,
      }),
    ).rejects.toThrow("malformed rollback target");

    expect(kubernetesClientFactory).not.toHaveBeenCalled();
    expect(prometheusFetch).not.toHaveBeenCalled();
  });

  it("rejects checkedAt preceding notBefore before calling either live system", async () => {
    const kubernetesClientFactory = vi.fn(async () => ({
      api: { readNamespacedDeployment: vi.fn() } as never,
      apiServer: "https://127.0.0.1:6443/",
    }));
    const prometheusFetch = passingPrometheusFetch();

    await expect(
      verifyDeploymentAndPrometheusRecovery({
        rawConfig: baseRawConfig(),
        idempotencyKey,
        target,
        notBefore: "2026-08-07T00:00:03.000Z",
        checkedAt: "2026-08-07T00:00:01.000Z",
        kubernetesClientFactory,
        prometheusFetch,
      }),
    ).rejects.toThrow("cannot precede remediation completion");

    expect(kubernetesClientFactory).not.toHaveBeenCalled();
    expect(prometheusFetch).not.toHaveBeenCalled();
  });

  it("propagates a Prometheus fetch failure instead of reporting a recovery result", async () => {
    const readNamespacedDeployment = vi.fn(async () => deployment());
    const prometheusFetch = vi.fn(async () => {
      throw new Error("prometheus unreachable");
    });

    await expect(
      verifyDeploymentAndPrometheusRecovery({
        rawConfig: baseRawConfig(),
        idempotencyKey,
        target,
        notBefore: "2026-08-07T00:00:01.000Z",
        checkedAt: "2026-08-07T00:00:03.000Z",
        kubernetesClientFactory: async () => ({
          api: { readNamespacedDeployment } as never,
          apiServer: "https://127.0.0.1:6443/",
        }),
        prometheusFetch,
      }),
    ).rejects.toThrow("prometheus unreachable");
  });
});
