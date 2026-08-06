import { describe, expect, it, vi } from "vitest";

import type {
  AppsV1Api,
  V1Deployment,
  V1PodTemplateSpec,
  V1ReplicaSet,
} from "@kubernetes/client-node";

import {
  canonicalizePodTemplate,
  decodeKubernetesDeploymentRollbackTarget,
  hashIdempotencyKey,
  KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
  performDeploymentRollback,
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
  selectReplicaSetForRevision,
  templateSha256,
  type KubernetesDeploymentRollbackTarget,
} from "./deployment-rollback.js";
import { resolveKubernetesToolConfig, type KubernetesToolConfig } from "./config.js";
import type { RemediationTarget } from "../state/incident-state.js";

const config: KubernetesToolConfig = resolveKubernetesToolConfig({
  kubernetes: {
    clusterId: "guardian-step3-kind",
    kubeconfigPath: "/etc/guardian/kubeconfig",
    allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
  },
});

function podTemplate(image: string, extraLabels: Record<string, string> = {}): V1PodTemplateSpec {
  return {
    metadata: {
      labels: { app: "payments", ...extraLabels },
    },
    spec: {
      containers: [{ name: "payments", image }],
    },
  } as V1PodTemplateSpec;
}

const v1Template = podTemplate("payments:v1");
const v2Template = podTemplate("payments:v2");
const v1TemplateHash = templateSha256(v1Template);
const v2TemplateHash = templateSha256(v2Template);

function validRawTarget(): RemediationTarget {
  return {
    type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
    clusterId: "guardian-step3-kind",
    namespace: "guardian-step3",
    deployment: "payments-step3",
    deploymentUid: "deployment-uid-1",
    fromRevision: 2,
    toRevision: 1,
    fromTemplateSha256: v2TemplateHash,
    toTemplateSha256: v1TemplateHash,
  };
}

const target: KubernetesDeploymentRollbackTarget =
  decodeKubernetesDeploymentRollbackTarget(validRawTarget()) as KubernetesDeploymentRollbackTarget;

describe("decodeKubernetesDeploymentRollbackTarget", () => {
  it("accepts a fully-specified valid target", () => {
    expect(decodeKubernetesDeploymentRollbackTarget(validRawTarget())).toEqual(
      validRawTarget(),
    );
  });

  it("rejects a missing field", () => {
    const raw = validRawTarget();
    delete raw.toRevision;
    expect(decodeKubernetesDeploymentRollbackTarget(raw)).toBeUndefined();
  });

  it("rejects an extra field", () => {
    const raw = { ...validRawTarget(), extra: "nope" };
    expect(decodeKubernetesDeploymentRollbackTarget(raw)).toBeUndefined();
  });

  it("rejects the wrong type literal", () => {
    const raw = { ...validRawTarget(), type: "kubernetes_deployment_rollback_v2" };
    expect(decodeKubernetesDeploymentRollbackTarget(raw)).toBeUndefined();
  });

  it("rejects an invalid namespace name", () => {
    const raw = { ...validRawTarget(), namespace: "Guardian_Step3" };
    expect(decodeKubernetesDeploymentRollbackTarget(raw)).toBeUndefined();
  });

  it("rejects fromRevision equal to toRevision", () => {
    const raw = { ...validRawTarget(), toRevision: 2 };
    expect(decodeKubernetesDeploymentRollbackTarget(raw)).toBeUndefined();
  });

  it("rejects a non-hex-64 template digest", () => {
    const raw = { ...validRawTarget(), toTemplateSha256: "not-a-digest" };
    expect(decodeKubernetesDeploymentRollbackTarget(raw)).toBeUndefined();
  });
});

describe("canonicalizePodTemplate / templateSha256", () => {
  it("strips pod-template-hash before hashing", () => {
    const withHash = podTemplate("payments:v1", { "pod-template-hash": "abc123" });
    expect(canonicalizePodTemplate(withHash).metadata?.labels).toEqual({
      app: "payments",
    });
    expect(templateSha256(withHash)).toBe(templateSha256(v1Template));
  });

  it("produces different digests for different content", () => {
    expect(templateSha256(v1Template)).not.toBe(templateSha256(v2Template));
  });
});

describe("selectReplicaSetForRevision", () => {
  function replicaSet(
    revision: number,
    ownerUid: string,
    template: V1PodTemplateSpec | undefined,
  ): V1ReplicaSet {
    return {
      metadata: {
        name: `rs-${revision}`,
        annotations: { "deployment.kubernetes.io/revision": String(revision) },
        ownerReferences: [
          { apiVersion: "apps/v1", kind: "Deployment", name: "payments-step3", uid: ownerUid, controller: true },
        ],
      },
      spec: template ? { template } : {},
    } as unknown as V1ReplicaSet;
  }

  it("selects the single owner-owned ReplicaSet for the revision", () => {
    const result = selectReplicaSetForRevision(
      [replicaSet(1, "deployment-uid-1", v1Template), replicaSet(2, "deployment-uid-1", v1Template)],
      "deployment-uid-1",
      1,
    );
    expect(result.ok).toBe(true);
  });

  it("fails closed when no ReplicaSet matches", () => {
    const result = selectReplicaSetForRevision(
      [replicaSet(2, "deployment-uid-1", v1Template)],
      "deployment-uid-1",
      1,
    );
    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining("no owner-owned ReplicaSet"),
    });
  });

  it("fails closed when the revision is ambiguous", () => {
    const result = selectReplicaSetForRevision(
      [replicaSet(1, "deployment-uid-1", v1Template), { ...replicaSet(1, "deployment-uid-1", v1Template), metadata: { ...replicaSet(1, "deployment-uid-1", v1Template).metadata, name: "rs-1-dup" } }],
      "deployment-uid-1",
      1,
    );
    expect(result.ok).toBe(false);
  });

  it("excludes ReplicaSets not owned by the Deployment UID", () => {
    const result = selectReplicaSetForRevision(
      [replicaSet(1, "some-other-uid", v1Template)],
      "deployment-uid-1",
      1,
    );
    expect(result.ok).toBe(false);
  });

  it("fails closed when the matched ReplicaSet has no PodTemplate", () => {
    const result = selectReplicaSetForRevision(
      [replicaSet(1, "deployment-uid-1", undefined)],
      "deployment-uid-1",
      1,
    );
    expect(result.ok).toBe(false);
  });
});

function baseDeployment(overrides: Partial<V1Deployment["metadata"]> = {}): V1Deployment {
  return {
    metadata: {
      name: "payments-step3",
      namespace: "guardian-step3",
      uid: "deployment-uid-1",
      resourceVersion: "111",
      annotations: { "deployment.kubernetes.io/revision": "2" },
      ...overrides,
    },
    spec: { template: v2Template },
  } as V1Deployment;
}

function historicalReplicaSetList(): { items: V1ReplicaSet[] } {
  return {
    items: [
      {
        metadata: {
          name: "rs-1",
          annotations: { "deployment.kubernetes.io/revision": "1" },
          ownerReferences: [
            { apiVersion: "apps/v1", kind: "Deployment", name: "payments-step3", uid: "deployment-uid-1", controller: true },
          ],
        },
        spec: { template: v1Template },
      },
      {
        metadata: {
          name: "rs-2",
          annotations: { "deployment.kubernetes.io/revision": "2" },
          ownerReferences: [
            { apiVersion: "apps/v1", kind: "Deployment", name: "payments-step3", uid: "deployment-uid-1", controller: true },
          ],
        },
        spec: { template: v2Template },
      },
    ] as unknown as V1ReplicaSet[],
  };
}

function neverCalledApi(): AppsV1Api {
  return {
    readNamespacedDeployment: vi.fn(() => {
      throw new Error("must not be called");
    }),
    listNamespacedReplicaSet: vi.fn(() => {
      throw new Error("must not be called");
    }),
    patchNamespacedDeployment: vi.fn(() => {
      throw new Error("must not be called");
    }),
  } as unknown as AppsV1Api;
}

describe("performDeploymentRollback", () => {
  it("rejects an out-of-allowlist target before any Kubernetes call", async () => {
    const api = neverCalledApi();
    const outOfScope: KubernetesDeploymentRollbackTarget = {
      ...target,
      namespace: "default",
      deployment: "other",
    };
    await expect(
      performDeploymentRollback({ config, api, idempotencyKey: "key-1", target: outOfScope }),
    ).rejects.toThrow("rejected by administrator allowlist");
    expect(api.readNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("rejects a clusterId mismatch before any Kubernetes call", async () => {
    const api = neverCalledApi();
    const mismatched: KubernetesDeploymentRollbackTarget = {
      ...target,
      clusterId: "some-other-cluster",
    };
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "key-1",
      target: mismatched,
    });
    expect(result).toMatchObject({ decision: "stale_target" });
    expect(api.readNamespacedDeployment).not.toHaveBeenCalled();
  });

  function apiWith(deployment: V1Deployment, patchImpl?: (body: unknown) => V1Deployment) {
    const patched = vi.fn(async ({ body }: { body: unknown }) => {
      if (patchImpl) {
        return patchImpl(body);
      }
      throw new Error("patch not expected");
    });
    return {
      readNamespacedDeployment: vi.fn(async () => deployment),
      listNamespacedReplicaSet: vi.fn(async () => historicalReplicaSetList()),
      patchNamespacedDeployment: patched,
    } as unknown as AppsV1Api;
  }

  it("rejects when the Deployment UID does not match the target", async () => {
    const api = apiWith(baseDeployment({ uid: "different-uid" } as never));
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "key-1",
      target,
    });
    expect(result).toMatchObject({ decision: "stale_target" });
  });

  it("rejects when the current revision does not match target.fromRevision", async () => {
    const deployment = baseDeployment();
    deployment.metadata!.annotations = { "deployment.kubernetes.io/revision": "5" };
    const api = apiWith(deployment);
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "key-1",
      target,
    });
    expect(result).toMatchObject({ decision: "stale_target" });
  });

  it("rejects when the live template digest does not match target.fromTemplateSha256", async () => {
    const deployment = baseDeployment();
    deployment.spec = { template: v1Template } as never;
    const api = apiWith(deployment);
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "key-1",
      target,
    });
    expect(result).toMatchObject({ decision: "stale_target" });
  });

  it("fails closed (ambiguous_history) when the historical ReplicaSet is missing", async () => {
    const deployment = baseDeployment();
    const api = {
      readNamespacedDeployment: vi.fn(async () => deployment),
      listNamespacedReplicaSet: vi.fn(async () => ({ items: [] })),
      patchNamespacedDeployment: vi.fn(),
    } as unknown as AppsV1Api;
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "key-1",
      target,
    });
    expect(result).toMatchObject({ decision: "ambiguous_history" });
    expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("fails closed (ambiguous_history) when the selected ReplicaSet's digest disagrees with the caller's claim", async () => {
    const deployment = baseDeployment();
    const mismatchedTarget: KubernetesDeploymentRollbackTarget = {
      ...target,
      toTemplateSha256: "0".repeat(64),
    };
    const api = apiWith(deployment);
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "key-1",
      target: mismatchedTarget,
    });
    expect(result).toMatchObject({ decision: "ambiguous_history" });
    expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
  });

  it("performs the rollback: strips pod-template-hash, writes audit annotations atomically", async () => {
    const deployment = baseDeployment();
    let capturedBody: unknown;
    const api = apiWith(deployment, (body) => {
      capturedBody = body;
      return {
        metadata: { ...deployment.metadata, resourceVersion: "112" },
      } as V1Deployment;
    });

    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "attempt-key-1",
      target,
    });

    expect(result).toMatchObject({
      decision: "rolled_back",
      deploymentUid: "deployment-uid-1",
      fromRevision: 2,
      toRevision: 1,
      templateSha256: v1TemplateHash,
      resourceVersion: "112",
      patched: true,
    });

    const ops = capturedBody as Array<Record<string, unknown>>;
    expect(ops).toContainEqual({ op: "test", path: "/metadata/uid", value: "deployment-uid-1" });
    expect(ops).toContainEqual({ op: "test", path: "/metadata/resourceVersion", value: "111" });

    const templateOp = ops.find((op) => op.path === "/spec/template") as { value: V1PodTemplateSpec };
    expect(templateOp.value.metadata?.labels).not.toHaveProperty("pod-template-hash");

    const annotationsOp = ops.find((op) => op.path === "/metadata/annotations") as {
      value: Record<string, string>;
    };
    expect(annotationsOp.value[ROLLBACK_KEY_HASH_ANNOTATION]).toBe(
      hashIdempotencyKey("attempt-key-1"),
    );
    expect(annotationsOp.value[ROLLBACK_FROM_REVISION_ANNOTATION]).toBe("2");
    expect(annotationsOp.value[ROLLBACK_TO_REVISION_ANNOTATION]).toBe("1");
    expect(annotationsOp.value[ROLLBACK_TEMPLATE_HASH_ANNOTATION]).toBe(v1TemplateHash);
  });

  it("returns resource_version_conflict without retrying when the API server rejects the patch preconditions", async () => {
    const deployment = baseDeployment();
    const api = apiWith(deployment, () => {
      throw Object.assign(new Error("conflict"), { statusCode: 409 });
    });
    const result = await performDeploymentRollback({
      config,
      api,
      idempotencyKey: "attempt-key-1",
      target,
    });
    expect(result).toMatchObject({ decision: "resource_version_conflict" });
    expect(api.patchNamespacedDeployment).toHaveBeenCalledTimes(1);
  });

  it("re-throws unexpected patch errors instead of recording a decision", async () => {
    const deployment = baseDeployment();
    const api = apiWith(deployment, () => {
      throw new Error("network timeout");
    });
    await expect(
      performDeploymentRollback({ config, api, idempotencyKey: "attempt-key-1", target }),
    ).rejects.toThrow("network timeout");
  });

  describe("idempotent replay", () => {
    function rolledBackDeployment(overrides: {
      keyHash?: string;
      fromRevision?: string;
      toRevision?: string;
      templateHash?: string;
      liveTemplate?: V1PodTemplateSpec;
    } = {}): V1Deployment {
      const deployment = baseDeployment();
      deployment.metadata!.annotations = {
        "deployment.kubernetes.io/revision": "3",
        [ROLLBACK_KEY_HASH_ANNOTATION]: overrides.keyHash ?? hashIdempotencyKey("attempt-key-1"),
        [ROLLBACK_FROM_REVISION_ANNOTATION]: overrides.fromRevision ?? "2",
        [ROLLBACK_TO_REVISION_ANNOTATION]: overrides.toRevision ?? "1",
        [ROLLBACK_TEMPLATE_HASH_ANNOTATION]: overrides.templateHash ?? v1TemplateHash,
      };
      deployment.spec = { template: overrides.liveTemplate ?? v1Template } as never;
      return deployment;
    }

    it("returns duplicate and does not patch again when everything matches", async () => {
      const api = apiWith(rolledBackDeployment());
      const result = await performDeploymentRollback({
        config,
        api,
        idempotencyKey: "attempt-key-1",
        target,
      });
      expect(result).toMatchObject({ decision: "duplicate", patched: false });
      expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it("returns key_conflict when the same key's recorded outcome disagrees with the requested target", async () => {
      const api = apiWith(rolledBackDeployment({ toRevision: "9" }));
      const result = await performDeploymentRollback({
        config,
        api,
        idempotencyKey: "attempt-key-1",
        target,
      });
      expect(result).toMatchObject({ decision: "key_conflict" });
      expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it("returns key_conflict when the same key's recorded fromRevision disagrees with the requested target", async () => {
      const api = apiWith(rolledBackDeployment({ fromRevision: "9" }));
      const result = await performDeploymentRollback({
        config,
        api,
        idempotencyKey: "attempt-key-1",
        target,
      });
      expect(result).toMatchObject({ decision: "key_conflict" });
      expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it("returns indeterminate without overwriting when the live template drifted after a matching replay", async () => {
      const api = apiWith(rolledBackDeployment({ liveTemplate: v2Template }));
      const result = await performDeploymentRollback({
        config,
        api,
        idempotencyKey: "attempt-key-1",
        target,
      });
      expect(result).toMatchObject({ decision: "indeterminate" });
      expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
    });

    it("allows a different idempotency key to roll the Deployment back again when live state matches the new target's fromRevision (second incident occurrence)", async () => {
      const previouslyRolledBack = rolledBackDeployment();
      let capturedBody: unknown;
      const api = apiWith(previouslyRolledBack, (body) => {
        capturedBody = body;
        return {
          metadata: { ...previouslyRolledBack.metadata, resourceVersion: "113" },
        } as V1Deployment;
      });

      const secondTarget: KubernetesDeploymentRollbackTarget = {
        ...target,
        fromRevision: 3,
        toRevision: 2,
        fromTemplateSha256: v1TemplateHash,
        toTemplateSha256: v2TemplateHash,
      };

      const result = await performDeploymentRollback({
        config,
        api,
        idempotencyKey: "attempt-key-2",
        target: secondTarget,
      });

      expect(result).toMatchObject({
        decision: "rolled_back",
        fromRevision: 3,
        toRevision: 2,
        templateSha256: v2TemplateHash,
      });

      const ops = capturedBody as Array<Record<string, unknown>>;
      const annotationsOp = ops.find((op) => op.path === "/metadata/annotations") as {
        value: Record<string, string>;
      };
      expect(annotationsOp.value[ROLLBACK_KEY_HASH_ANNOTATION]).toBe(
        hashIdempotencyKey("attempt-key-2"),
      );
      expect(annotationsOp.value[ROLLBACK_FROM_REVISION_ANNOTATION]).toBe("3");
      expect(annotationsOp.value[ROLLBACK_TO_REVISION_ANNOTATION]).toBe("2");
      expect(annotationsOp.value[ROLLBACK_TEMPLATE_HASH_ANNOTATION]).toBe(v2TemplateHash);
    });

    it("fails closed (stale_target) for a different idempotency key when live state does not match the new target's fromRevision", async () => {
      const api = apiWith(rolledBackDeployment());
      const secondTarget: KubernetesDeploymentRollbackTarget = {
        ...target,
        fromRevision: 5,
        toRevision: 2,
        fromTemplateSha256: v1TemplateHash,
        toTemplateSha256: v2TemplateHash,
      };
      const result = await performDeploymentRollback({
        config,
        api,
        idempotencyKey: "attempt-key-2",
        target: secondTarget,
      });
      expect(result).toMatchObject({ decision: "stale_target" });
      expect(api.patchNamespacedDeployment).not.toHaveBeenCalled();
    });
  });
});
