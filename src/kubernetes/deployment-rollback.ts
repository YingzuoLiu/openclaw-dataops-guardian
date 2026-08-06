import { createHash } from "node:crypto";

import type { AppsV1Api, V1Deployment, V1PodTemplateSpec, V1ReplicaSet } from "@kubernetes/client-node";

import type { RemediationTarget } from "../state/incident-state.js";
import { assertAllowlistedTarget, type KubernetesToolConfig } from "./config.js";

export const KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE =
  "kubernetes_deployment_rollback_v1" as const;

export const ROLLBACK_KEY_HASH_ANNOTATION =
  "guardian.openclaw.dev/rollback-key-sha256";
export const ROLLBACK_FROM_REVISION_ANNOTATION =
  "guardian.openclaw.dev/rollback-from-revision";
export const ROLLBACK_TO_REVISION_ANNOTATION =
  "guardian.openclaw.dev/rollback-to-revision";
export const ROLLBACK_TEMPLATE_HASH_ANNOTATION =
  "guardian.openclaw.dev/rollback-template-sha256";

const DEPLOYMENT_REVISION_ANNOTATION = "deployment.kubernetes.io/revision";
const POD_TEMPLATE_HASH_LABEL = "pod-template-hash";
const FIELD_MANAGER = "guardian-deployment-rollback";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type KubernetesDeploymentRollbackTarget = {
  type: typeof KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE;
  clusterId: string;
  namespace: string;
  deployment: string;
  deploymentUid: string;
  fromRevision: number;
  toRevision: number;
  fromTemplateSha256: string;
  toTemplateSha256: string;
};

const TARGET_KEYS = [
  "type",
  "clusterId",
  "namespace",
  "deployment",
  "deploymentUid",
  "fromRevision",
  "toRevision",
  "fromTemplateSha256",
  "toTemplateSha256",
] as const;

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidResourceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    NAME_PATTERN.test(value)
  );
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX_PATTERN.test(value);
}

/**
 * Strictly decodes a persisted RemediationTarget into a Kubernetes rollback
 * target. Every field is required, no extra keys are allowed, and every
 * value is shape-checked; anything else fails closed (returns undefined)
 * rather than guessing.
 */
export function decodeKubernetesDeploymentRollbackTarget(
  target: RemediationTarget,
): KubernetesDeploymentRollbackTarget | undefined {
  const keys = Object.keys(target);
  if (
    keys.length !== TARGET_KEYS.length ||
    !TARGET_KEYS.every((key) => keys.includes(key))
  ) {
    return undefined;
  }
  if (target.type !== KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE) {
    return undefined;
  }
  if (
    !isNonEmptyString(target.clusterId) ||
    !isValidResourceName(target.namespace) ||
    !isValidResourceName(target.deployment) ||
    !isNonEmptyString(target.deploymentUid) ||
    !isPositiveInteger(target.fromRevision) ||
    !isPositiveInteger(target.toRevision) ||
    target.fromRevision === target.toRevision ||
    !isSha256Hex(target.fromTemplateSha256) ||
    !isSha256Hex(target.toTemplateSha256)
  ) {
    return undefined;
  }

  return {
    type: KUBERNETES_DEPLOYMENT_ROLLBACK_TARGET_TYPE,
    clusterId: target.clusterId as string,
    namespace: target.namespace as string,
    deployment: target.deployment as string,
    deploymentUid: target.deploymentUid as string,
    fromRevision: target.fromRevision as number,
    toRevision: target.toRevision as number,
    fromTemplateSha256: target.fromTemplateSha256 as string,
    toTemplateSha256: target.toTemplateSha256 as string,
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Only the digest of the idempotency key is ever persisted to Kubernetes. */
export function hashIdempotencyKey(key: string): string {
  return sha256Hex(`guardian-rollback-key-v1\0${key}`);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * Removes the controller-injected pod-template-hash label so a template read
 * from a historical ReplicaSet can be written back onto the Deployment (and
 * so two otherwise-identical templates hash identically regardless of which
 * ReplicaSet they were read from).
 */
export function canonicalizePodTemplate(
  template: V1PodTemplateSpec,
): V1PodTemplateSpec {
  const clone = structuredClone(template);
  if (clone.metadata?.labels) {
    const { [POD_TEMPLATE_HASH_LABEL]: _dropped, ...rest } = clone.metadata.labels;
    clone.metadata.labels = rest;
  }
  return clone;
}

export function templateSha256(template: V1PodTemplateSpec): string {
  return sha256Hex(stableStringify(canonicalizePodTemplate(template)));
}

function readRevisionAnnotation(
  annotations: Record<string, string> | undefined,
): number | undefined {
  const raw = annotations?.[DEPLOYMENT_REVISION_ANNOTATION];
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isOwnedByDeployment(
  replicaSet: V1ReplicaSet,
  deploymentUid: string,
): boolean {
  return (replicaSet.metadata?.ownerReferences ?? []).some(
    (owner) =>
      owner.kind === "Deployment" &&
      owner.uid === deploymentUid &&
      owner.controller === true,
  );
}

export type SelectReplicaSetResult =
  | { ok: true; replicaSet: V1ReplicaSet }
  | { ok: false; reason: string };

/**
 * Finds the single controller-owned historical ReplicaSet for a revision.
 * Anything other than exactly one unambiguous match fails closed.
 */
export function selectReplicaSetForRevision(
  replicaSets: V1ReplicaSet[],
  deploymentUid: string,
  revision: number,
): SelectReplicaSetResult {
  const candidates = replicaSets.filter(
    (replicaSet) =>
      isOwnedByDeployment(replicaSet, deploymentUid) &&
      readRevisionAnnotation(replicaSet.metadata?.annotations) === revision,
  );
  if (candidates.length === 0) {
    return {
      ok: false,
      reason: `no owner-owned ReplicaSet found for revision ${revision}`,
    };
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      reason: `revision ${revision} is ambiguous across ${candidates.length} owner-owned ReplicaSets`,
    };
  }
  const replicaSet = candidates[0]!;
  if (!replicaSet.spec?.template) {
    return {
      ok: false,
      reason: `revision ${revision} ReplicaSet has no PodTemplate`,
    };
  }
  return { ok: true, replicaSet };
}

export type DeploymentRollbackResult =
  | {
      decision: "rolled_back" | "duplicate";
      namespace: string;
      deployment: string;
      deploymentUid: string;
      fromRevision: number;
      toRevision: number;
      templateSha256: string;
      resourceVersion: string;
      patched: boolean;
    }
  | {
      decision:
        | "stale_target"
        | "ambiguous_history"
        | "key_conflict"
        | "indeterminate"
        | "resource_version_conflict";
      reason: string;
    };

function conflictStatusCode(error: unknown): number | undefined {
  const withStatus = error as {
    code?: number;
    statusCode?: number;
    response?: { statusCode?: number; status?: number };
  };
  const status =
    withStatus?.code ??
    withStatus?.statusCode ??
    withStatus?.response?.statusCode ??
    withStatus?.response?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Performs (or safely no-ops) one allowlisted Deployment rollback.
 *
 * Every "reject" decision below is returned *before* any mutating API call,
 * or after a JSON Patch whose `test` preconditions failed atomically at the
 * API server (so nothing was written) -- callers may safely record these as
 * a definite failed attempt. Anything this function does not explicitly
 * decide (network errors, timeouts, unexpected exceptions) is re-thrown so
 * the caller does *not* record a failed attempt for an indeterminate cause.
 */
export async function performDeploymentRollback(input: {
  config: KubernetesToolConfig;
  api: AppsV1Api;
  idempotencyKey: string;
  target: KubernetesDeploymentRollbackTarget;
}): Promise<DeploymentRollbackResult> {
  const { config, api, idempotencyKey, target } = input;
  assertAllowlistedTarget(config, target.namespace, target.deployment);
  if (target.clusterId !== config.clusterId) {
    return {
      decision: "stale_target",
      reason: "target.clusterId does not match the configured Kubernetes cluster",
    };
  }

  const current: V1Deployment = await api.readNamespacedDeployment({
    name: target.deployment,
    namespace: target.namespace,
  });
  const metadata = current.metadata;
  const resourceVersion = metadata?.resourceVersion;
  const liveTemplate = current.spec?.template;
  if (!metadata?.uid || !resourceVersion || !liveTemplate) {
    return {
      decision: "stale_target",
      reason: "Deployment is missing uid, resourceVersion, or spec.template",
    };
  }
  if (metadata.uid !== target.deploymentUid) {
    return {
      decision: "stale_target",
      reason: "Deployment UID does not match the rollback target",
    };
  }

  const keyHash = hashIdempotencyKey(idempotencyKey);
  const annotations = metadata.annotations ?? {};
  const existingKeyHash = annotations[ROLLBACK_KEY_HASH_ANNOTATION];
  const liveTemplateHash = templateSha256(liveTemplate);

  if (existingKeyHash !== undefined && existingKeyHash === keyHash) {
    const recordedFromRevision = annotations[ROLLBACK_FROM_REVISION_ANNOTATION];
    const recordedToRevision = annotations[ROLLBACK_TO_REVISION_ANNOTATION];
    const recordedTemplateHash = annotations[ROLLBACK_TEMPLATE_HASH_ANNOTATION];
    const recordedMatchesRequest =
      recordedFromRevision === String(target.fromRevision) &&
      recordedToRevision === String(target.toRevision) &&
      recordedTemplateHash === target.toTemplateSha256;
    if (!recordedMatchesRequest) {
      return {
        decision: "key_conflict",
        reason:
          "the recorded rollback outcome for this idempotency key does not match the requested target",
      };
    }
    if (liveTemplateHash !== target.toTemplateSha256) {
      return {
        decision: "indeterminate",
        reason:
          "rollback-key annotation matches, but the live PodTemplate no longer matches the recorded result",
      };
    }
    return {
      decision: "duplicate",
      namespace: target.namespace,
      deployment: target.deployment,
      deploymentUid: metadata.uid,
      fromRevision: target.fromRevision,
      toRevision: target.toRevision,
      templateSha256: liveTemplateHash,
      resourceVersion,
      patched: false,
    };
  }

  // Either this Deployment has never carried a rollback audit annotation, or
  // a *different* idempotency key is asking for one -- e.g. a second, later
  // incident occurrence rolling the same Deployment back again after it was
  // redeployed. Both cases re-validate against the Deployment's current live
  // state before writing anything, so a stale or fabricated target still
  // fails closed; a legitimate new rollback atomically overwrites the
  // previous key's audit annotations via the wholesale annotations replace
  // below. This never weakens the persisted running-attempt gate upstream in
  // buildRollbackDeploymentToolGateDecision, which already required an
  // approved incident with exactly one running attempt whose idempotencyKey
  // and target exactly match this call.
  const currentRevision = readRevisionAnnotation(annotations);
  if (currentRevision !== target.fromRevision) {
    return {
      decision: "stale_target",
      reason: `Deployment current revision ${currentRevision ?? "unknown"} does not match target.fromRevision ${target.fromRevision}`,
    };
  }
  if (liveTemplateHash !== target.fromTemplateSha256) {
    return {
      decision: "stale_target",
      reason: "live PodTemplate digest does not match target.fromTemplateSha256",
    };
  }

  const replicaSetList = await api.listNamespacedReplicaSet({
    namespace: target.namespace,
  });
  const selection = selectReplicaSetForRevision(
    replicaSetList.items ?? [],
    target.deploymentUid,
    target.toRevision,
  );
  if (!selection.ok) {
    return { decision: "ambiguous_history", reason: selection.reason };
  }
  const historicalTemplate = selection.replicaSet.spec!.template!;
  const historicalTemplateHash = templateSha256(historicalTemplate);
  if (historicalTemplateHash !== target.toTemplateSha256) {
    return {
      decision: "ambiguous_history",
      reason:
        "the selected historical ReplicaSet's PodTemplate digest does not match target.toTemplateSha256",
    };
  }
  const canonicalTemplate = canonicalizePodTemplate(historicalTemplate);

  const mergedAnnotations: Record<string, string> = {
    ...annotations,
    [ROLLBACK_KEY_HASH_ANNOTATION]: keyHash,
    [ROLLBACK_FROM_REVISION_ANNOTATION]: String(target.fromRevision),
    [ROLLBACK_TO_REVISION_ANNOTATION]: String(target.toRevision),
    [ROLLBACK_TEMPLATE_HASH_ANNOTATION]: historicalTemplateHash,
  };

  let patched: V1Deployment;
  try {
    patched = await api.patchNamespacedDeployment({
      name: target.deployment,
      namespace: target.namespace,
      fieldManager: FIELD_MANAGER,
      fieldValidation: "Strict",
      body: [
        { op: "test", path: "/metadata/uid", value: metadata.uid },
        { op: "test", path: "/metadata/resourceVersion", value: resourceVersion },
        { op: "replace", path: "/spec/template", value: canonicalTemplate },
        { op: "replace", path: "/metadata/annotations", value: mergedAnnotations },
      ],
    });
  } catch (error) {
    const status = conflictStatusCode(error);
    if (status === 409 || status === 412 || status === 422) {
      return {
        decision: "resource_version_conflict",
        reason:
          "Kubernetes rejected the patch preconditions; the Deployment changed between read and write",
      };
    }
    throw error;
  }

  const patchedResourceVersion = patched.metadata?.resourceVersion;
  if (!patchedResourceVersion) {
    throw new Error(
      "Kubernetes returned a patched Deployment without a resourceVersion",
    );
  }

  return {
    decision: "rolled_back",
    namespace: target.namespace,
    deployment: target.deployment,
    deploymentUid: metadata.uid,
    fromRevision: target.fromRevision,
    toRevision: target.toRevision,
    templateSha256: historicalTemplateHash,
    resourceVersion: patchedResourceVersion,
    patched: true,
  };
}
