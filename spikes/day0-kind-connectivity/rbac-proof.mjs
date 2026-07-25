import { AppsV1Api, KubeConfig } from "@kubernetes/client-node";

const kubeconfigPath = process.argv[2];
if (!kubeconfigPath) {
  throw new Error("usage: node rbac-proof.mjs <scoped-kubeconfig>");
}

const kubeconfig = new KubeConfig();
kubeconfig.loadFromFile(kubeconfigPath);
const api = kubeconfig.makeApiClient(AppsV1Api);

const allowed = await api.readNamespacedDeployment({
  namespace: "guardian-day0",
  name: "payments-day0",
});

let outsideDenied = false;
let outsideStatus = null;
try {
  await api.readNamespacedDeployment({
    namespace: "default",
    name: "outside-day0",
  });
} catch (error) {
  outsideStatus =
    error?.code ??
    error?.statusCode ??
    error?.response?.statusCode ??
    error?.response?.status ??
    null;
  outsideDenied = Number(outsideStatus) === 403;
}

if (!allowed.metadata?.uid || !outsideDenied) {
  throw new Error(
    `scoped kubeconfig RBAC proof failed: ${JSON.stringify({
      allowedRead: Boolean(allowed.metadata?.uid),
      outsideDenied,
      outsideStatus,
    })}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    allowedRead: true,
    allowedTarget: "guardian-day0/payments-day0",
    outsideReadDeniedByRbac: true,
    outsideStatus,
  })}\n`,
);
