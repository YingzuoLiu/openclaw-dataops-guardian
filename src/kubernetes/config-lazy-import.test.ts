import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const temporaryRoots: string[] = [];

afterEach(async () => {
  vi.doUnmock("@kubernetes/client-node");
  vi.resetModules();
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Kubernetes client runtime loading", () => {
  it("defers the client-node barrel until a real client is requested", async () => {
    const moduleLoaded = vi.fn();
    const api = { kind: "apps-v1" };

    vi.doMock("@kubernetes/client-node", () => {
      moduleLoaded();
      class FakeAppsV1Api {}
      class FakeKubeConfig {
        loadFromString(): void {}
        makePathsAbsolute(): void {}
        getCurrentContext(): string {
          return "proof-cluster";
        }
        getCurrentCluster(): { server: string } {
          return { server: "https://127.0.0.1:6443" };
        }
        makeApiClient(): typeof api {
          return api;
        }
      }
      return { AppsV1Api: FakeAppsV1Api, KubeConfig: FakeKubeConfig };
    });

    await import("../index.js");
    expect(moduleLoaded).not.toHaveBeenCalled();

    const configModule = await import("./config.js");

    const root = await mkdtemp(join(tmpdir(), "guardian-kube-lazy-test-"));
    temporaryRoots.push(root);
    const kubeconfigPath = join(root, "config.yaml");
    await writeFile(kubeconfigPath, "non-empty fixture\n", "utf8");

    const client = await configModule.createKubernetesDeploymentClient({
      clusterId: "proof-cluster",
      kubeconfigPath,
      allowlist: [{ namespace: "proof", deployment: "payments" }],
    });

    expect(moduleLoaded).toHaveBeenCalledTimes(1);
    expect(client).toEqual({
      api,
      apiServer: "https://127.0.0.1:6443/",
    });
  });
});
