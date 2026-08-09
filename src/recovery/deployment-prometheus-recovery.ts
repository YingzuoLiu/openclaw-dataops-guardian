import type { V1Deployment } from "@kubernetes/client-node";

import {
  createKubernetesDeploymentClient,
  requireRecoveryPolicy,
  resolveKubernetesToolConfig,
  type KubernetesDeploymentClient,
  type KubernetesRecoveryPolicy,
  type KubernetesToolConfig,
} from "../kubernetes/config.js";
import {
  decodeKubernetesDeploymentRollbackTarget,
  hashIdempotencyKey,
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
  templateSha256,
  type KubernetesDeploymentRollbackTarget,
} from "../kubernetes/deployment-rollback.js";
import type { RemediationTarget } from "../state/incident-state.js";
import {
  queryPrometheusInstant,
  resolvePrometheusToolConfig,
  type PrometheusInstantResult,
  type PrometheusToolConfig,
} from "../tools/query-prometheus.js";

type PrometheusFetch = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export type DeploymentRecoveryObservation = {
  healthy: boolean;
  issues: string[];
  namespace: string;
  deployment: string;
  deploymentUid: string | null;
  generation: number | null;
  observedGeneration: number | null;
  desiredReplicas: number | null;
  updatedReplicas: number;
  availableReplicas: number;
  unavailableReplicas: number;
  templateSha256: string | null;
};

export type PrometheusRecoveryObservation = {
  healthy: boolean;
  issues: string[];
  query: string;
  comparator: "gte" | "lte";
  threshold: number;
  currentValue: number;
  observedAt: string;
  labels: Record<string, string>;
};

export type DeploymentPrometheusRecoveryResult = {
  decision: "recovered" | "not_recovered";
  checkedAt: string;
  notBefore: string;
  target: KubernetesDeploymentRollbackTarget;
  deployment: DeploymentRecoveryObservation;
  prometheus: PrometheusRecoveryObservation;
  summary: string;
};

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/**
 * Verifies the live Deployment result without returning its PodTemplate or
 * environment. The rollback audit tuple is checked alongside readiness so a
 * different rollout cannot accidentally satisfy this recovery check.
 */
export function inspectDeploymentRecovery(
  deployment: V1Deployment,
  target: KubernetesDeploymentRollbackTarget,
  idempotencyKey: string,
): DeploymentRecoveryObservation {
  const issues: string[] = [];
  const metadata = deployment.metadata;
  const status = deployment.status;
  const desiredReplicas = finiteInteger(deployment.spec?.replicas);
  const generation = finiteInteger(metadata?.generation);
  const observedGeneration = finiteInteger(status?.observedGeneration);
  const updatedReplicas = finiteInteger(status?.updatedReplicas) ?? 0;
  const availableReplicas = finiteInteger(status?.availableReplicas) ?? 0;
  const unavailableReplicas = finiteInteger(status?.unavailableReplicas) ?? 0;
  const liveTemplateSha256 = deployment.spec?.template
    ? templateSha256(deployment.spec.template)
    : null;
  const annotations = metadata?.annotations ?? {};

  if (metadata?.uid !== target.deploymentUid) {
    issues.push("deployment_uid_mismatch");
  }
  if (liveTemplateSha256 !== target.toTemplateSha256) {
    issues.push("deployment_template_mismatch");
  }
  if (
    annotations[ROLLBACK_KEY_HASH_ANNOTATION] !==
    hashIdempotencyKey(idempotencyKey)
  ) {
    issues.push("rollback_key_audit_mismatch");
  }
  if (
    annotations[ROLLBACK_FROM_REVISION_ANNOTATION] !==
    String(target.fromRevision)
  ) {
    issues.push("rollback_from_revision_audit_mismatch");
  }
  if (
    annotations[ROLLBACK_TO_REVISION_ANNOTATION] !== String(target.toRevision)
  ) {
    issues.push("rollback_to_revision_audit_mismatch");
  }
  if (
    annotations[ROLLBACK_TEMPLATE_HASH_ANNOTATION] !== target.toTemplateSha256
  ) {
    issues.push("rollback_template_audit_mismatch");
  }
  if (desiredReplicas === null || desiredReplicas < 1) {
    issues.push("desired_replicas_not_positive");
  }
  if (
    generation === null ||
    observedGeneration === null ||
    observedGeneration < generation
  ) {
    issues.push("deployment_generation_not_observed");
  }
  if (
    desiredReplicas !== null &&
    (updatedReplicas !== desiredReplicas ||
      availableReplicas !== desiredReplicas ||
      unavailableReplicas !== 0)
  ) {
    issues.push("deployment_replicas_not_ready");
  }

  return {
    healthy: issues.length === 0,
    issues,
    namespace: target.namespace,
    deployment: target.deployment,
    deploymentUid: metadata?.uid ?? null,
    generation,
    observedGeneration,
    desiredReplicas,
    updatedReplicas,
    availableReplicas,
    unavailableReplicas,
    templateSha256: liveTemplateSha256,
  };
}

export function inspectPrometheusRecovery(
  result: PrometheusInstantResult,
  policy: KubernetesRecoveryPolicy,
  params: { notBefore: string; checkedAt: string },
): PrometheusRecoveryObservation {
  const issues: string[] = [];
  const observedAtMs = Date.parse(result.observedAt);
  const notBeforeMs = Date.parse(params.notBefore);
  const checkedAtMs = Date.parse(params.checkedAt);
  const maxAgeMs = policy.maxSampleAgeSeconds * 1_000;
  const observedAtValid = Number.isFinite(observedAtMs);
  const notBeforeValid = Number.isFinite(notBeforeMs);
  const checkedAtValid = Number.isFinite(checkedAtMs);

  if (!observedAtValid) {
    issues.push("prometheus_sample_timestamp_invalid");
  }
  if (!notBeforeValid) {
    issues.push("prometheus_recovery_not_before_invalid");
  }
  if (!checkedAtValid) {
    issues.push("prometheus_recovery_checked_at_invalid");
  }
  if (observedAtValid && notBeforeValid && observedAtMs < notBeforeMs) {
    issues.push("prometheus_sample_precedes_remediation");
  }
  if (
    observedAtValid &&
    checkedAtValid &&
    checkedAtMs - observedAtMs > maxAgeMs
  ) {
    issues.push("prometheus_sample_stale");
  }
  if (
    observedAtValid &&
    checkedAtValid &&
    observedAtMs - checkedAtMs > 30_000
  ) {
    issues.push("prometheus_sample_from_future");
  }
  const thresholdPassed =
    policy.comparator === "gte"
      ? result.currentValue >= policy.threshold
      : result.currentValue <= policy.threshold;
  if (!thresholdPassed) {
    issues.push("prometheus_threshold_not_met");
  }

  return {
    healthy: issues.length === 0,
    issues,
    query: policy.prometheusQuery,
    comparator: policy.comparator,
    threshold: policy.threshold,
    currentValue: result.currentValue,
    observedAt: result.observedAt,
    labels: result.labels,
  };
}

export type RecoveryKubernetesClientFactory = (
  config: KubernetesToolConfig,
) => Promise<KubernetesDeploymentClient>;

export async function verifyDeploymentAndPrometheusRecovery(input: {
  rawConfig: unknown;
  idempotencyKey: string;
  target: RemediationTarget;
  notBefore: string;
  checkedAt?: string;
  kubernetesClientFactory?: RecoveryKubernetesClientFactory;
  prometheusFetch?: PrometheusFetch;
}): Promise<DeploymentPrometheusRecoveryResult> {
  const target = decodeKubernetesDeploymentRollbackTarget(input.target);
  if (!target) {
    throw new Error("recovery verification received a malformed rollback target");
  }
  if (!Number.isFinite(Date.parse(input.notBefore))) {
    throw new Error("recovery verification notBefore must be a valid timestamp");
  }
  if (
    input.checkedAt !== undefined &&
    !Number.isFinite(Date.parse(input.checkedAt))
  ) {
    throw new Error("recovery verification checkedAt must be a valid timestamp");
  }
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  if (Date.parse(checkedAt) < Date.parse(input.notBefore)) {
    throw new Error("recovery verification cannot precede remediation completion");
  }

  const kubernetesConfig = resolveKubernetesToolConfig(input.rawConfig);
  const policy = requireRecoveryPolicy(
    kubernetesConfig,
    target.namespace,
    target.deployment,
  );
  if (target.clusterId !== kubernetesConfig.clusterId) {
    throw new Error("recovery target clusterId does not match configured cluster");
  }
  const prometheusConfig: PrometheusToolConfig =
    resolvePrometheusToolConfig(input.rawConfig);
  const kubernetesClientFactory =
    input.kubernetesClientFactory ?? createKubernetesDeploymentClient;

  const [{ api }, prometheusResult] = await Promise.all([
    kubernetesClientFactory(kubernetesConfig),
    queryPrometheusInstant(
      prometheusConfig,
      { query: policy.prometheusQuery },
      input.prometheusFetch,
    ),
  ]);
  const deploymentRecord = await api.readNamespacedDeployment({
    namespace: target.namespace,
    name: target.deployment,
  });
  const deployment = inspectDeploymentRecovery(
    deploymentRecord,
    target,
    input.idempotencyKey,
  );
  const prometheus = inspectPrometheusRecovery(prometheusResult, policy, {
    notBefore: input.notBefore,
    checkedAt,
  });
  const recovered = deployment.healthy && prometheus.healthy;

  return {
    decision: recovered ? "recovered" : "not_recovered",
    checkedAt,
    notBefore: input.notBefore,
    target,
    deployment,
    prometheus,
    summary: recovered
      ? `Deployment ${target.namespace}/${target.deployment} is ready on the audited rollback template and Prometheus ${policy.comparator} ${policy.threshold} passed.`
      : `Recovery checks failed: ${[
          ...deployment.issues,
          ...prometheus.issues,
        ].join(", ")}.`,
  };
}
