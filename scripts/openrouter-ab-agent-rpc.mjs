import { randomUUID } from "node:crypto";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import {
  buildPrompt,
  REQUIRED_TOOLS,
} from "../evals/openrouter-ab/scenarios.mjs";

const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19186";
const sessionKey = process.env.GUARDIAN_AB_SESSION_KEY;
const scenario = process.env.GUARDIAN_AB_SCENARIO;
const replicate = Number(process.env.GUARDIAN_AB_REPLICATE ?? "0");
const trialId = process.env.GUARDIAN_AB_TRIAL_ID;

if (!token || !sessionKey || !scenario || !trialId) {
  throw new Error(
    "OPENCLAW_GATEWAY_TOKEN, GUARDIAN_AB_SESSION_KEY, GUARDIAN_AB_SCENARIO, and GUARDIAN_AB_TRIAL_ID are required",
  );
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
  clientDisplayName: "dataops-guardian-openrouter-ab",
  clientVersion: "2026.6.34",
  platform: process.platform,
  mode: "ui",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 120_000,
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

  const prompt = buildPrompt(scenario, replicate);
  const startedAt = new Date().toISOString();
  const accepted = await client.request("agent", {
    message: prompt,
    agentId: "main",
    sessionKey,
    thinking: "off",
    promptMode: "minimal",
    bootstrapContextMode: "lightweight",
    deliver: false,
    timeout: 120_000,
    idempotencyKey: `guardian-openrouter-ab:${trialId}:${randomUUID()}`,
  });

  if (accepted?.status !== "accepted" || typeof accepted.runId !== "string") {
    throw new Error(`agent run was not accepted: ${JSON.stringify(accepted)}`);
  }

  const waited = await client.request("agent.wait", {
    runId: accepted.runId,
    timeoutMs: 120_000,
  });
  if (waited?.status !== "ok") {
    throw new Error(`agent run did not complete: ${JSON.stringify(waited)}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      trialId,
      scenario,
      replicate,
      prompt,
      requiredTools: REQUIRED_TOOLS,
      runId: accepted.runId,
      sessionKey,
      waitStatus: waited.status,
      startedAt,
      completedAt: new Date().toISOString(),
    })}\n`,
  );
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
