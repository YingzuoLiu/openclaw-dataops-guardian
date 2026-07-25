import { chmod, writeFile } from "node:fs/promises";

import { KubeConfig } from "@kubernetes/client-node";

const [adminKubeconfigPath, outputPath] = process.argv.slice(2);
const token = process.env.GUARDIAN_DAY0_SERVICE_ACCOUNT_TOKEN;

if (!adminKubeconfigPath || !outputPath || !token) {
  throw new Error(
    "usage: GUARDIAN_DAY0_SERVICE_ACCOUNT_TOKEN=... node write-scoped-kubeconfig.mjs <admin-kubeconfig> <output>",
  );
}

const admin = new KubeConfig();
admin.loadFromFile(adminKubeconfigPath);
const cluster = admin.getCurrentCluster();
if (!cluster?.server) {
  throw new Error("admin kubeconfig has no current cluster");
}

const scoped = new KubeConfig();
scoped.loadFromOptions({
  clusters: [
    {
      name: "guardian-day0",
      server: cluster.server,
      caData: cluster.caData,
      caFile: cluster.caFile,
      skipTLSVerify: cluster.skipTLSVerify,
      tlsServerName: cluster.tlsServerName,
    },
  ],
  users: [
    {
      name: "guardian-day0",
      token,
    },
  ],
  contexts: [
    {
      name: "guardian-day0",
      cluster: "guardian-day0",
      user: "guardian-day0",
      namespace: "guardian-day0",
    },
  ],
  currentContext: "guardian-day0",
});

await writeFile(outputPath, scoped.exportConfig(), {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(outputPath, 0o600);
