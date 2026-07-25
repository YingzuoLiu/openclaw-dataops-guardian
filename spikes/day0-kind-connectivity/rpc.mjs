import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const TOOL_NAME = "guardian_day0_kind_connectivity";
const mode = process.argv[2] ?? "full";
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19185";

if (!new Set(["full", "deny-only"]).has(mode)) {
  throw new Error("usage: node rpc.mjs <full|deny-only>");
}
if (!token) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

const client = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  clientName: "openclaw-tui",
  clientDisplayName: "guardian-day0-kind-spike",
  clientVersion: "2026.6.9",
  platform: process.platform,
  mode: "ui",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 30_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});

async function invoke(args) {
  return client.request("tools.invoke", {
    name: TOOL_NAME,
    args,
  });
}

function assertSuccessfulInvocation(invocation, action) {
  if (invocation.ok !== true || !invocation.output?.details) {
    throw new Error(
      `${action} invocation failed: ${JSON.stringify(invocation)}`,
    );
  }
  return invocation.output.details;
}

async function run() {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("gateway connect timeout")), 15_000),
    ),
  ]);

  const catalog = await client.request("tools.catalog", {
    agentId: "main",
    includePlugins: true,
  });
  const catalogTool = catalog.groups
    ?.flatMap((group) => group.tools ?? [])
    .find((tool) => tool.id === TOOL_NAME);
  if (
    !catalogTool ||
    catalogTool.pluginId !== "guardian-day0-kind-connectivity"
  ) {
    throw new Error(`${TOOL_NAME} was not loaded by the Gateway`);
  }

  const denied = await invoke({
    action: "read",
    namespace: "default",
    deployment: "outside-day0",
  });
  const deniedDetails = assertSuccessfulInvocation(denied, "outside read");
  if (
    deniedDetails.denied !== true ||
    deniedDetails.reason !== "static_allowlist"
  ) {
    throw new Error(
      `outside target was not rejected by the plugin allowlist: ${JSON.stringify(denied)}`,
    );
  }

  if (mode === "deny-only") {
    return {
      schemaVersion: 1,
      ok: true,
      mode,
      gatewayToolLoaded: true,
      outsideTargetDeniedBeforeKubernetesAccess: true,
    };
  }

  const read = assertSuccessfulInvocation(
    await invoke({
      action: "read",
      namespace: "guardian-day0",
      deployment: "payments-day0",
    }),
    "read",
  );
  const write = assertSuccessfulInvocation(
    await invoke({
      action: "patch_and_restore",
      namespace: "guardian-day0",
      deployment: "payments-day0",
    }),
    "patch_and_restore",
  );

  if (
    read.execution?.context !== "openclaw_gateway_plugin" ||
    !read.execution?.kubeconfigReadable ||
    !read.deployment?.uid ||
    write.writeObserved !== true ||
    write.restored !== true
  ) {
    throw new Error(
      `Gateway Kubernetes proof was incomplete: ${JSON.stringify({ read, write })}`,
    );
  }

  return {
    schemaVersion: 1,
    ok: true,
    mode,
    gatewayToolLoaded: true,
    gatewayProcess: {
      pid: read.execution.pid,
      nodeVersion: read.execution.nodeVersion,
    },
    kubeconfigReadable: true,
    apiServer: read.execution.apiServer,
    deploymentRead: {
      namespace: read.deployment.namespace,
      deployment: read.deployment.deployment,
      uid: read.deployment.uid,
      resourceVersion: read.deployment.resourceVersion,
    },
    controlledWriteObserved: true,
    controlledWriteRestored: true,
    outsideTargetDeniedBeforeKubernetesAccess: true,
  };
}

try {
  process.stdout.write(`${JSON.stringify(await run(), null, 2)}\n`);
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
