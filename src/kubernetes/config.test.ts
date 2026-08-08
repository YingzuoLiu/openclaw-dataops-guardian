import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KubeConfig } from "@kubernetes/client-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertAllowlistedTarget,
  createKubernetesDeploymentClient,
  isAllowlistedTarget,
  resolveKubernetesToolConfig,
  type KubernetesToolConfig,
} from "./config.js";

const validRawConfig = {
  kubernetes: {
    clusterId: "guardian-step3-kind",
    kubeconfigPath: "/etc/guardian/kubeconfig",
    allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
  },
};

const recovery = {
  prometheusQuery: 'payment_success_rate{service="payments"}',
  comparator: "gte" as const,
  threshold: 0.95,
  maxSampleAgeSeconds: 120,
};

describe("resolveKubernetesToolConfig", () => {
  it("accepts a well-formed administrator configuration", () => {
    expect(resolveKubernetesToolConfig(validRawConfig)).toEqual({
      clusterId: "guardian-step3-kind",
      kubeconfigPath: "/etc/guardian/kubeconfig",
      allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
    });
  });

  it("parses an administrator-owned recovery policy on an allowlisted target", () => {
    expect(
      resolveKubernetesToolConfig({
        kubernetes: {
          ...validRawConfig.kubernetes,
          allowlist: [
            {
              namespace: "guardian-step3",
              deployment: "payments-step3",
              recovery,
            },
          ],
        },
      }).allowlist[0],
    ).toEqual({
      namespace: "guardian-step3",
      deployment: "payments-step3",
      recovery,
    });
  });

  it("rejects malformed recovery policy rather than applying defaults", () => {
    expect(() =>
      resolveKubernetesToolConfig({
        kubernetes: {
          ...validRawConfig.kubernetes,
          allowlist: [
            {
              namespace: "guardian-step3",
              deployment: "payments-step3",
              recovery: { ...recovery, threshold: Number.NaN },
            },
          ],
        },
      }),
    ).toThrow("threshold must be a finite number");
  });

  it("rejects a missing clusterId", () => {
    expect(() =>
      resolveKubernetesToolConfig({
        kubernetes: { ...validRawConfig.kubernetes, clusterId: "" },
      }),
    ).toThrow("clusterId is required");
  });

  it("rejects a relative kubeconfig path", () => {
    expect(() =>
      resolveKubernetesToolConfig({
        kubernetes: {
          ...validRawConfig.kubernetes,
          kubeconfigPath: "relative/kubeconfig",
        },
      }),
    ).toThrow("must be an absolute path");
  });

  it("rejects an empty allowlist", () => {
    expect(() =>
      resolveKubernetesToolConfig({
        kubernetes: { ...validRawConfig.kubernetes, allowlist: [] },
      }),
    ).toThrow("non-empty array");
  });

  it("rejects an allowlist entry with an invalid Kubernetes name", () => {
    expect(() =>
      resolveKubernetesToolConfig({
        kubernetes: {
          ...validRawConfig.kubernetes,
          allowlist: [{ namespace: "Guardian_Step3", deployment: "payments" }],
        },
      }),
    ).toThrow("valid Kubernetes names");
  });
});

describe("isAllowlistedTarget / assertAllowlistedTarget", () => {
  const config = resolveKubernetesToolConfig(validRawConfig);

  it("allows only the exact configured namespace/deployment pair", () => {
    expect(isAllowlistedTarget(config, "guardian-step3", "payments-step3")).toBe(
      true,
    );
    expect(isAllowlistedTarget(config, "default", "payments-step3")).toBe(false);
    expect(isAllowlistedTarget(config, "guardian-step3", "other-deployment")).toBe(
      false,
    );
  });

  it("throws before any Kubernetes access is attempted for an out-of-scope target", () => {
    expect(() =>
      assertAllowlistedTarget(config, "kube-system", "coredns"),
    ).toThrow("rejected by administrator allowlist");
  });
});

describe("createKubernetesDeploymentClient", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "guardian-kubeconfig-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  async function writeKubeconfig(overrides: {
    server?: string;
    contextName?: string;
    relativeCredentialPaths?: boolean;
  } = {}): Promise<KubernetesToolConfig> {
    const contextName = overrides.contextName ?? "guardian-step3-kind";
    const server = overrides.server ?? "https://127.0.0.1:6443";
    const clusterCredentials = overrides.relativeCredentialPaths
      ? "      certificate-authority: pki/ca.crt"
      : "      insecure-skip-tls-verify: true";
    const userCredentials = overrides.relativeCredentialPaths
      ? `      client-certificate: pki/client.crt
      client-key: pki/client.key`
      : "      token: fake-token";
    const kubeconfigPath = join(dir, "kubeconfig");
    await writeFile(
      kubeconfigPath,
      `apiVersion: v1
kind: Config
clusters:
  - name: guardian-step3-kind
    cluster:
      server: ${server}
${clusterCredentials}
users:
  - name: guardian-step3-kind
    user:
${userCredentials}
contexts:
  - name: ${contextName}
    context:
      cluster: guardian-step3-kind
      user: guardian-step3-kind
      namespace: guardian-step3
current-context: ${contextName}
`,
      "utf8",
    );
    return {
      clusterId: "guardian-step3-kind",
      kubeconfigPath,
      allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
    };
  }

  it("builds a client from a kubeconfig whose context matches the configured clusterId", async () => {
    const config = await writeKubeconfig();
    const client = await createKubernetesDeploymentClient(config);
    expect(client.apiServer).toBe("https://127.0.0.1:6443/");
  });

  it("loads the checked document once and anchors relative credential paths", async () => {
    const config = await writeKubeconfig({ relativeCredentialPaths: true });
    const loadFromFile = vi.spyOn(KubeConfig.prototype, "loadFromFile");
    const originalMakePathsAbsolute = KubeConfig.prototype.makePathsAbsolute;
    let loadedKubeconfig: KubeConfig | undefined;
    const makePathsAbsolute = vi
      .spyOn(KubeConfig.prototype, "makePathsAbsolute")
      .mockImplementation(function (this: KubeConfig, rootDirectory: string) {
        originalMakePathsAbsolute.call(this, rootDirectory);
        loadedKubeconfig = this;
      });

    await createKubernetesDeploymentClient(config);

    expect(loadFromFile).not.toHaveBeenCalled();
    expect(makePathsAbsolute).toHaveBeenCalledOnce();
    expect(makePathsAbsolute).toHaveBeenCalledWith(dir);
    expect(loadedKubeconfig?.getCurrentCluster()?.caFile).toBe(
      join(dir, "pki", "ca.crt"),
    );
    expect(loadedKubeconfig?.getCurrentUser()?.certFile).toBe(
      join(dir, "pki", "client.crt"),
    );
    expect(loadedKubeconfig?.getCurrentUser()?.keyFile).toBe(
      join(dir, "pki", "client.key"),
    );
  });

  it("rejects an empty kubeconfig document", async () => {
    const config = await writeKubeconfig();
    await writeFile(config.kubeconfigPath, "", "utf8");
    await expect(createKubernetesDeploymentClient(config)).rejects.toThrow(
      "kubeconfig file is empty",
    );
  });

  it("rejects a kubeconfig whose current-context does not match clusterId", async () => {
    const config = await writeKubeconfig({ contextName: "some-other-cluster" });
    await expect(createKubernetesDeploymentClient(config)).rejects.toThrow(
      "does not match the configured clusterId",
    );
  });

  it("rejects a non-HTTPS API server", async () => {
    const config = await writeKubeconfig({ server: "http://127.0.0.1:6443" });
    await expect(createKubernetesDeploymentClient(config)).rejects.toThrow(
      "must use HTTPS",
    );
  });

  it("rejects credentials embedded in the API server URL", async () => {
    const config = await writeKubeconfig({
      server: "https://user:secret@127.0.0.1:6443",
    });
    await expect(createKubernetesDeploymentClient(config)).rejects.toThrow(
      "must not contain credentials",
    );
  });

  it("rejects a kubeconfig path that does not exist", async () => {
    const config: KubernetesToolConfig = {
      clusterId: "guardian-step3-kind",
      kubeconfigPath: join(dir, "missing-kubeconfig"),
      allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
    };
    await expect(createKubernetesDeploymentClient(config)).rejects.toThrow();
  });
});
