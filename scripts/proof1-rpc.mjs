import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const TOOL_NAME = "guardian_inspect_metric_snapshot";
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19183";

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
  clientDisplayName: "dataops-guardian-proof1",
  clientVersion: "2026.6.34",
  platform: process.platform,
  mode: "ui",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 15_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});

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

  if (!catalogTool || catalogTool.pluginId !== "dataops-guardian") {
    throw new Error(`${TOOL_NAME} was not loaded into the plugin tool catalog`);
  }

  const invocation = await client.request("tools.invoke", {
    name: TOOL_NAME,
    args: {
      alertId: "proof1-payment-success-rate-drop",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
    },
  });

  if (invocation.ok !== true) {
    throw new Error(`tool invocation failed: ${JSON.stringify(invocation)}`);
  }
  if (invocation.output?.details?.classification !== "critical") {
    throw new Error(`unexpected tool result: ${JSON.stringify(invocation.output)}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      catalogLoaded: true,
      invoked: true,
      toolName: TOOL_NAME,
      classification: invocation.output.details.classification,
    })}\n`,
  );
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
