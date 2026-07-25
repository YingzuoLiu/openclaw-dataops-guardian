import { readFile } from "node:fs/promises";

const [preflightPath, rbacPath, rpcPath, cleanupPath] = process.argv.slice(2);
if (!preflightPath || !rbacPath || !rpcPath || !cleanupPath) {
  throw new Error(
    "usage: node summarize-proof.mjs <preflight> <rbac> <rpc> <cleanup>",
  );
}

const [preflight, rbac, rpc, cleanup] = await Promise.all(
  [preflightPath, rbacPath, rpcPath, cleanupPath].map(async (path) =>
    JSON.parse(await readFile(path, "utf8")),
  ),
);

const proof = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  ok: Boolean(preflight.ok && rbac.ok && rpc.ok && cleanup.ok),
  environment: preflight.environment,
  versions: {
    docker: preflight.docker.version,
    kind: preflight.kind.version,
    kubectl: preflight.kubectl.version,
  },
  executionContext: rpc.gatewayProcess,
  kubeconfig: {
    providedToGatewayAsAbsolutePath: true,
    readableFromGatewayPlugin: rpc.kubeconfigReadable,
    credentialsRedacted: true,
  },
  apiServer: rpc.apiServer,
  read: rpc.deploymentRead,
  controlledWrite: {
    observed: rpc.controlledWriteObserved,
    restored: rpc.controlledWriteRestored,
  },
  boundaries: {
    pluginAllowlistDeniedOutsideTarget:
      rpc.outsideTargetDeniedBeforeKubernetesAccess,
    scopedKubeconfigDeniedOutsideNamespace: rbac.outsideReadDeniedByRbac,
    outsideStatus: rbac.outsideStatus,
  },
  cleanup,
};

process.stdout.write(`${JSON.stringify(proof, null, 2)}\n`);
