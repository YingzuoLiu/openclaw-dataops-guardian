import { readFile, writeFile } from "node:fs/promises";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const command = process.argv[2];
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19183";
const markerPath = process.env.OPENCLAW_PROOF3_MARKER;
const tokenPath = process.env.OPENCLAW_PROOF3_TOKEN_FILE;

if (!new Set(["run", "resume"]).has(command)) {
  throw new Error("usage: npm run proof3:rpc -- <run|resume>");
}
if (!token || !markerPath || !tokenPath) {
  throw new Error(
    "OPENCLAW_GATEWAY_TOKEN, OPENCLAW_PROOF3_MARKER, and OPENCLAW_PROOF3_TOKEN_FILE are required",
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
  clientDisplayName: "dataops-guardian-proof3",
  clientVersion: "2026.6.34",
  platform: process.platform,
  mode: "ui",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 20_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});

async function readMarker() {
  return JSON.parse(await readFile(markerPath, "utf8"));
}

async function invokeLobster(args) {
  const invocation = await client.request("tools.invoke", {
    name: "lobster",
    args,
  });

  if (invocation.ok !== true) {
    throw new Error(`Lobster invocation failed: ${JSON.stringify(invocation)}`);
  }
  return invocation.output?.details;
}

async function run() {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("gateway connect timeout")), 15_000),
    ),
  ]);

  if (command === "run") {
    await writeFile(
      markerPath,
      `${JSON.stringify({ prepareCount: 0, applyCount: 0 }, null, 2)}\n`,
      "utf8",
    );

    const result = await invokeLobster({
      action: "run",
      pipeline: "workflows/proof3-approval.lobster",
      cwd: ".",
      timeoutMs: 15_000,
    });
    const resumeToken = result?.requiresApproval?.resumeToken;

    if (result?.status !== "needs_approval" || !resumeToken) {
      throw new Error(`workflow did not pause for approval: ${JSON.stringify(result)}`);
    }
    const marker = await readMarker();
    if (marker.prepareCount !== 1 || marker.applyCount !== 0) {
      throw new Error(`unexpected marker before approval: ${JSON.stringify(marker)}`);
    }

    await writeFile(tokenPath, `${resumeToken}\n`, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        command,
        ok: true,
        status: result.status,
        prepareCount: marker.prepareCount,
        applyCount: marker.applyCount,
      })}\n`,
    );
    return;
  }

  const resumeToken = (await readFile(tokenPath, "utf8")).trim();
  const result = await invokeLobster({
    action: "resume",
    token: resumeToken,
    approve: true,
    cwd: ".",
    timeoutMs: 15_000,
  });
  const marker = await readMarker();

  if (result?.status !== "ok") {
    throw new Error(`workflow did not complete after approval: ${JSON.stringify(result)}`);
  }
  if (marker.prepareCount !== 1 || marker.applyCount !== 1) {
    throw new Error(`workflow reran or skipped a step: ${JSON.stringify(marker)}`);
  }

  process.stdout.write(
    `${JSON.stringify({
      command,
      ok: true,
      status: result.status,
      prepareCount: marker.prepareCount,
      applyCount: marker.applyCount,
    })}\n`,
  );
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
