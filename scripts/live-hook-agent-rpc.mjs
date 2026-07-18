import { randomUUID } from "node:crypto";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19184";
const sessionKey =
  process.env.OPENCLAW_LIVE_HOOK_SESSION_KEY ??
  "agent:main:dataops-guardian-live-hook-proof";

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
  clientDisplayName: "dataops-guardian-live-hook-proof",
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

async function run() {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("gateway connect timeout")), 15_000),
    ),
  ]);

  const accepted = await client.request("agent", {
    message:
      "Determine whether payment_success_rate is healthy and give a final operational conclusion.",
    agentId: "main",
    sessionKey,
    thinking: "off",
    promptMode: "minimal",
    bootstrapContextMode: "lightweight",
    deliver: false,
    timeout: 30_000,
    idempotencyKey: `guardian-live-hook-proof:${randomUUID()}`,
  });

  if (accepted?.status !== "accepted" || typeof accepted.runId !== "string") {
    throw new Error(`agent run was not accepted: ${JSON.stringify(accepted)}`);
  }

  const waited = await client.request("agent.wait", {
    runId: accepted.runId,
    timeoutMs: 30_000,
  });
  if (waited?.status !== "ok") {
    throw new Error(`agent run did not complete: ${JSON.stringify(waited)}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      gatewayAgentRun: true,
      runId: accepted.runId,
      sessionKey,
      waitStatus: waited.status,
    })}\n`,
  );
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
