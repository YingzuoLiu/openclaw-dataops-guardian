import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { AppsV1Api, KubeConfig } from "@kubernetes/client-node";

const NAME_PATTERN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

export type KubernetesAllowlistEntry = {
  namespace: string;
  deployment: string;
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
      return { namespace: record.namespace, deployment: record.deployment };
    },
  );

  return { clusterId, kubeconfigPath, allowlist };
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
  await access(config.kubeconfigPath, fsConstants.R_OK);
  const stats = await readFile(config.kubeconfigPath, "utf8");
  if (stats.length === 0) {
    throw new Error("kubeconfig file is empty");
  }

  const kubeconfig = new KubeConfig();
  kubeconfig.loadFromFile(config.kubeconfigPath);

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
