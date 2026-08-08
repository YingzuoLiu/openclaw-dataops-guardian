import { readFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

import { AppsV1Api, KubeConfig } from "@kubernetes/client-node";

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type KubernetesAllowlistEntry = {
  namespace: string;
  deployment: string;
  recovery?: KubernetesRecoveryPolicy;
};

export type KubernetesRecoveryPolicy = {
  prometheusQuery: string;
  comparator: "gte" | "lte";
  threshold: number;
  maxSampleAgeSeconds: number;
};

export type KubernetesToolConfig = {
  clusterId: string;
  kubeconfigPath: string;
  allowlist: KubernetesAllowlistEntry[];
};

export type KubernetesDeploymentClient = {
  api: AppsV1Api;
  apiServer: string;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isValidResourceName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 253 &&
    NAME_PATTERN.test(value)
  );
}

function parseRecoveryPolicy(
  value: unknown,
  path: string,
): KubernetesRecoveryPolicy | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = readRecord(value);
  if (!record) {
    throw new Error(`${path} must be an object`);
  }
  const prometheusQuery =
    typeof record.prometheusQuery === "string"
      ? record.prometheusQuery.trim()
      : "";
  if (!prometheusQuery || prometheusQuery.length > 2_048) {
    throw new Error(
      `${path}.prometheusQuery must be a non-empty string of at most 2048 characters`,
    );
  }
  if (!new Set(["gte", "lte"]).has(record.comparator as string)) {
    throw new Error(`${path}.comparator must be gte or lte`);
  }
  if (typeof record.threshold !== "number" || !Number.isFinite(record.threshold)) {
    throw new Error(`${path}.threshold must be a finite number`);
  }
  const maxSampleAgeSeconds = record.maxSampleAgeSeconds;
  if (
    typeof maxSampleAgeSeconds !== "number" ||
    !Number.isInteger(maxSampleAgeSeconds) ||
    maxSampleAgeSeconds < 1 ||
    maxSampleAgeSeconds > 86_400
  ) {
    throw new Error(
      `${path}.maxSampleAgeSeconds must be an integer from 1 through 86400`,
    );
  }
  return {
    prometheusQuery,
    comparator: record.comparator as "gte" | "lte",
    threshold: record.threshold,
    maxSampleAgeSeconds,
  };
}

/**
 * Parses the administrator-configured Kubernetes rollback settings. Nothing
 * here is model- or caller-supplied: clusterId, kubeconfigPath, and the
 * allowlist all come from plugin config only.
 */
export function resolveKubernetesToolConfig(
  rawConfig: unknown,
): KubernetesToolConfig {
  const config = readRecord(rawConfig);
  const kubernetesConfig = readRecord(config?.kubernetes);

  const clusterId =
    typeof kubernetesConfig?.clusterId === "string"
      ? kubernetesConfig.clusterId.trim()
      : "";
  if (!clusterId) {
    throw new Error(
      "plugins.entries.dataops-guardian.config.kubernetes.clusterId is required",
    );
  }

  const kubeconfigPath =
    typeof kubernetesConfig?.kubeconfigPath === "string"
      ? kubernetesConfig.kubeconfigPath.trim()
      : "";
  if (!kubeconfigPath) {
    throw new Error(
      "plugins.entries.dataops-guardian.config.kubernetes.kubeconfigPath is required",
    );
  }
  if (!isAbsolute(kubeconfigPath)) {
    throw new Error("kubernetes.kubeconfigPath must be an absolute path");
  }

  const rawAllowlist = kubernetesConfig?.allowlist;
  if (!Array.isArray(rawAllowlist) || rawAllowlist.length === 0) {
    throw new Error(
      "kubernetes.allowlist must be a non-empty array of {namespace, deployment}",
    );
  }
  const allowlist: KubernetesAllowlistEntry[] = rawAllowlist.map(
    (entry, index) => {
      const record = readRecord(entry);
      if (
        !isValidResourceName(record?.namespace) ||
        !isValidResourceName(record?.deployment)
      ) {
        throw new Error(
          `kubernetes.allowlist[${index}] must be {namespace, deployment} valid Kubernetes names`,
        );
      }
      const recovery = parseRecoveryPolicy(
        record.recovery,
        `kubernetes.allowlist[${index}].recovery`,
      );
      return {
        namespace: record.namespace,
        deployment: record.deployment,
        ...(recovery ? { recovery } : {}),
      };
    },
  );

  return { clusterId, kubeconfigPath, allowlist };
}

export function requireRecoveryPolicy(
  config: KubernetesToolConfig,
  namespace: string,
  deployment: string,
): KubernetesRecoveryPolicy {
  const entry = config.allowlist.find(
    (candidate) =>
      candidate.namespace === namespace &&
      candidate.deployment === deployment,
  );
  if (!entry) {
    throw new Error(
      `target rejected by administrator allowlist: ${namespace}/${deployment}`,
    );
  }
  if (!entry.recovery) {
    throw new Error(
      `administrator recovery policy is missing for ${namespace}/${deployment}`,
    );
  }
  return entry.recovery;
}

export function isAllowlistedTarget(
  config: KubernetesToolConfig,
  namespace: string,
  deployment: string,
): boolean {
  return config.allowlist.some(
    (entry) => entry.namespace === namespace && entry.deployment === deployment,
  );
}

export function assertAllowlistedTarget(
  config: KubernetesToolConfig,
  namespace: string,
  deployment: string,
): void {
  if (!isAllowlistedTarget(config, namespace, deployment)) {
    throw new Error(
      `target rejected by administrator allowlist: ${namespace}/${deployment}`,
    );
  }
}

/**
 * Builds a scoped AppsV1Api client strictly from the administrator-configured
 * kubeconfig. The kubeconfig's current context name must equal the
 * configured clusterId so a kubeconfig file cannot be swapped without also
 * updating the plugin config that authorizes it.
 */
export async function createKubernetesDeploymentClient(
  config: KubernetesToolConfig,
): Promise<KubernetesDeploymentClient> {
  const kubeconfigDocument = await readFile(config.kubeconfigPath, "utf8");
  if (kubeconfigDocument.length === 0) {
    throw new Error("kubeconfig file is empty");
  }

  const kubeconfig = new KubeConfig();
  kubeconfig.loadFromString(kubeconfigDocument);
  kubeconfig.makePathsAbsolute(dirname(config.kubeconfigPath));

  if (kubeconfig.getCurrentContext() !== config.clusterId) {
    throw new Error(
      "kubeconfig current-context does not match the configured clusterId",
    );
  }

  const cluster = kubeconfig.getCurrentCluster();
  if (!cluster?.server) {
    throw new Error("kubeconfig has no current API server");
  }
  const apiServer = new URL(cluster.server);
  if (apiServer.protocol !== "https:") {
    throw new Error("Kubernetes API server must use HTTPS");
  }
  if (apiServer.username || apiServer.password) {
    throw new Error("Kubernetes API server URL must not contain credentials");
  }

  return {
    api: kubeconfig.makeApiClient(AppsV1Api),
    apiServer: apiServer.toString(),
  };
}
