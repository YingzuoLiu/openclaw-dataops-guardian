import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

import { AppsV1Api, KubeConfig } from "@kubernetes/client-node";

export const ALLOWED_NAMESPACE = "guardian-day0";
export const ALLOWED_DEPLOYMENT = "payments-day0";
export const SPIKE_ANNOTATION = "guardian.openclaw.dev/day0-spike";

function readRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

export function assertAllowedTarget(namespace, deployment) {
  if (
    namespace !== ALLOWED_NAMESPACE ||
    deployment !== ALLOWED_DEPLOYMENT
  ) {
    throw new Error(
      `target rejected by static allowlist; expected ${ALLOWED_NAMESPACE}/${ALLOWED_DEPLOYMENT}`,
    );
  }
}

export function resolveKubeconfigPath(rawConfig) {
  const config = readRecord(rawConfig);
  const kubeconfigPath =
    typeof config?.kubeconfigPath === "string"
      ? config.kubeconfigPath.trim()
      : "";

  if (!kubeconfigPath) {
    throw new Error(
      "plugins.entries.guardian-day0-kind-connectivity.config.kubeconfigPath is required",
    );
  }
  if (!isAbsolute(kubeconfigPath)) {
    throw new Error("Day 0 kubeconfigPath must be absolute");
  }
  return kubeconfigPath;
}

export async function createKubernetesClient(rawConfig) {
  const kubeconfigPath = resolveKubeconfigPath(rawConfig);
  await access(kubeconfigPath, fsConstants.R_OK);

  const kubeconfig = new KubeConfig();
  kubeconfig.loadFromFile(kubeconfigPath);
  const cluster = kubeconfig.getCurrentCluster();

  if (!cluster?.server) {
    throw new Error("Day 0 kubeconfig has no current API server");
  }
  const apiServer = new URL(cluster.server);
  if (apiServer.protocol !== "https:") {
    throw new Error("Day 0 Kubernetes API server must use HTTPS");
  }
  if (apiServer.username || apiServer.password) {
    throw new Error("Day 0 Kubernetes API server URL must not contain credentials");
  }

  return {
    api: kubeconfig.makeApiClient(AppsV1Api),
    apiServer: apiServer.toString(),
  };
}

function deploymentSummary(deployment) {
  const metadata = deployment?.metadata;
  if (!metadata?.uid || !metadata.resourceVersion) {
    throw new Error("Kubernetes returned Deployment without UID/resourceVersion");
  }

  return {
    namespace: metadata.namespace,
    deployment: metadata.name,
    uid: metadata.uid,
    resourceVersion: metadata.resourceVersion,
    generation: metadata.generation ?? null,
    observedGeneration: deployment.status?.observedGeneration ?? null,
    replicas: deployment.status?.replicas ?? 0,
    availableReplicas: deployment.status?.availableReplicas ?? 0,
  };
}

function escapeJsonPointerSegment(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

async function readDeployment(api, namespace, deployment) {
  return api.readNamespacedDeployment({
    namespace,
    name: deployment,
  });
}

async function replaceSpikeAnnotation(
  api,
  deployment,
  expectedValue,
  nextValue,
) {
  const metadata = deployment.metadata;
  const resourceVersion = metadata?.resourceVersion;
  if (!resourceVersion) {
    throw new Error("cannot patch Deployment without resourceVersion");
  }

  const currentValue = metadata.annotations?.[SPIKE_ANNOTATION];
  if (currentValue !== expectedValue) {
    throw new Error(
      `unexpected ${SPIKE_ANNOTATION} value before patch; expected ${expectedValue}`,
    );
  }

  const annotationPath = `/metadata/annotations/${escapeJsonPointerSegment(SPIKE_ANNOTATION)}`;
  return api.patchNamespacedDeployment({
    namespace: ALLOWED_NAMESPACE,
    name: ALLOWED_DEPLOYMENT,
    fieldManager: "guardian-day0-spike",
    fieldValidation: "Strict",
    body: [
      {
        op: "test",
        path: "/metadata/resourceVersion",
        value: resourceVersion,
      },
      {
        op: "test",
        path: annotationPath,
        value: expectedValue,
      },
      {
        op: "replace",
        path: annotationPath,
        value: nextValue,
      },
    ],
  });
}

export async function patchAndRestoreDeployment(api, marker = randomUUID()) {
  const initial = await readDeployment(
    api,
    ALLOWED_NAMESPACE,
    ALLOWED_DEPLOYMENT,
  );
  const initialSummary = deploymentSummary(initial);
  const baselineValue = initial.metadata?.annotations?.[SPIKE_ANNOTATION];
  if (typeof baselineValue !== "string" || baselineValue.length === 0) {
    throw new Error(
      `test Deployment must start with a non-empty ${SPIKE_ANNOTATION} annotation`,
    );
  }

  let writeObserved = false;
  let restored = false;
  let patchedSummary;
  let primaryError;

  try {
    await replaceSpikeAnnotation(api, initial, baselineValue, marker);
    writeObserved = true;

    const patched = await readDeployment(
      api,
      ALLOWED_NAMESPACE,
      ALLOWED_DEPLOYMENT,
    );
    patchedSummary = deploymentSummary(patched);
    if (patched.metadata?.annotations?.[SPIKE_ANNOTATION] !== marker) {
      throw new Error("controlled Deployment patch was not observable");
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (writeObserved) {
      try {
        const latest = await readDeployment(
          api,
          ALLOWED_NAMESPACE,
          ALLOWED_DEPLOYMENT,
        );
        await replaceSpikeAnnotation(api, latest, marker, baselineValue);

        const afterRestore = await readDeployment(
          api,
          ALLOWED_NAMESPACE,
          ALLOWED_DEPLOYMENT,
        );
        restored =
          afterRestore.metadata?.annotations?.[SPIKE_ANNOTATION] ===
          baselineValue;
        if (!restored) {
          throw new Error("controlled Deployment patch was not restored");
        }
      } catch (restoreError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, restoreError],
            "Day 0 patch failed and automatic restore also failed",
          );
        }
        throw restoreError;
      }
    }
  }

  if (primaryError) {
    throw primaryError;
  }

  return {
    writeObserved,
    restored,
    annotation: SPIKE_ANNOTATION,
    initial: initialSummary,
    patched: patchedSummary,
  };
}

export async function runKubernetesProbe({
  rawConfig,
  action,
  namespace,
  deployment,
  clientFactory = createKubernetesClient,
  marker,
}) {
  assertAllowedTarget(namespace, deployment);

  if (!new Set(["read", "patch_and_restore"]).has(action)) {
    throw new Error("unsupported Day 0 action");
  }

  const { api, apiServer } = await clientFactory(rawConfig);
  const execution = {
    context: "openclaw_gateway_plugin",
    pid: process.pid,
    nodeVersion: process.version,
    kubeconfigReadable: true,
    apiServer,
  };

  if (action === "read") {
    const current = await readDeployment(api, namespace, deployment);
    return {
      action,
      execution,
      deployment: deploymentSummary(current),
    };
  }

  return {
    action,
    execution,
    ...(await patchAndRestoreDeployment(api, marker)),
  };
}
