import type {
  ExternalReconciliationOutcome,
  ExternalReconciliationRequest,
  ExternalRemediationReconciler,
} from "../state/restart-reconciliation.js";
import {
  createKubernetesDeploymentClient,
  isAllowlistedTarget,
  type KubernetesDeploymentClient,
  type KubernetesToolConfig,
} from "./config.js";
import {
  decodeKubernetesDeploymentRollbackTarget,
  hashIdempotencyKey,
  ROLLBACK_FROM_REVISION_ANNOTATION,
  ROLLBACK_KEY_HASH_ANNOTATION,
  ROLLBACK_TEMPLATE_HASH_ANNOTATION,
  ROLLBACK_TO_REVISION_ANNOTATION,
  templateSha256,
} from "./deployment-rollback.js";

/**
 * Read-only restart reconciler for the Kubernetes Deployment rollback tool.
 *
 * This never mutates and never re-dispatches a rollback: it only inspects
 * the live Deployment and decides whether the evidence conclusively shows
 * the attempt succeeded. Anything short of that -- an unreadable Deployment,
 * a recreated UID, a partial or mismatched audit trail -- comes back as
 * "unknown" so the caller leaves the incident in manual review rather than
 * guessing at success or failure.
 */
export class KubernetesDeploymentRollbackReconciler
  implements ExternalRemediationReconciler
{
  private readonly config: KubernetesToolConfig;
  private readonly clientFactory: (
    config: KubernetesToolConfig,
  ) => Promise<KubernetesDeploymentClient>;

  constructor(
    config: KubernetesToolConfig,
    clientFactory: (
      config: KubernetesToolConfig,
    ) => Promise<KubernetesDeploymentClient> = createKubernetesDeploymentClient,
  ) {
    this.config = config;
    this.clientFactory = clientFactory;
  }

  async reconcile(
    request: ExternalReconciliationRequest,
  ): Promise<ExternalReconciliationOutcome> {
    const target = decodeKubernetesDeploymentRollbackTarget(request.target);
    if (!target) {
      return {
        outcome: "unknown",
        summary:
          "the running attempt's target is not a recognized Kubernetes Deployment rollback target",
      };
    }
    if (target.clusterId !== this.config.clusterId) {
      return {
        outcome: "unknown",
        summary: "target.clusterId does not match the configured Kubernetes cluster",
      };
    }
    if (!isAllowlistedTarget(this.config, target.namespace, target.deployment)) {
      return {
        outcome: "unknown",
        summary: "target is outside the administrator-configured allowlist",
      };
    }

    let deployment;
    try {
      const { api } = await this.clientFactory(this.config);
      deployment = await api.readNamespacedDeployment({
        name: target.deployment,
        namespace: target.namespace,
      });
    } catch {
      return {
        outcome: "unknown",
        summary: `could not read Deployment ${target.namespace}/${target.deployment} to confirm the rollback outcome`,
      };
    }

    const metadata = deployment.metadata;
    const liveTemplate = deployment.spec?.template;
    if (!metadata?.uid || !liveTemplate) {
      return {
        outcome: "unknown",
        summary: "Deployment is missing uid or spec.template",
      };
    }
    if (metadata.uid !== target.deploymentUid) {
      return {
        outcome: "unknown",
        summary:
          "the Deployment UID no longer matches the running attempt (deleted and recreated, or wrong target)",
      };
    }

    const annotations = metadata.annotations ?? {};
    const matchesKey =
      annotations[ROLLBACK_KEY_HASH_ANNOTATION] ===
      hashIdempotencyKey(request.idempotencyKey);
    const matchesFromRevision =
      annotations[ROLLBACK_FROM_REVISION_ANNOTATION] === String(target.fromRevision);
    const matchesRevision =
      annotations[ROLLBACK_TO_REVISION_ANNOTATION] === String(target.toRevision);
    const matchesAnnotationDigest =
      annotations[ROLLBACK_TEMPLATE_HASH_ANNOTATION] === target.toTemplateSha256;
    const matchesLiveTemplate = templateSha256(liveTemplate) === target.toTemplateSha256;

    if (
      matchesKey &&
      matchesFromRevision &&
      matchesRevision &&
      matchesAnnotationDigest &&
      matchesLiveTemplate
    ) {
      return {
        outcome: "confirmed_succeeded",
        summary: `Deployment ${target.namespace}/${target.deployment} PodTemplate matches revision ${target.toRevision} and carries matching rollback audit annotations for this idempotency key.`,
      };
    }

    return {
      outcome: "unknown",
      summary:
        "the Deployment's audit annotations or live PodTemplate do not conclusively confirm this rollback attempt",
    };
  }
}
