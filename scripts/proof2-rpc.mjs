import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

const SESSION_KEY = "agent:main:dataops-guardian-proof2";
const PLUGIN_ID = "dataops-guardian";
const NAMESPACE = "incident";

const expectedState = {
  schemaVersion: 1,
  alertId: "proof2-payment-success-rate-drop",
  stage: "evidence_collection",
  evidence: [
    {
      source: "proof2-fixture",
      observedAt: "2026-07-18T00:00:00.000Z",
      summary: "Synthetic success-rate drop used only by the compatibility test.",
    },
  ],
  proposedAction: null,
  approvalStatus: "not_requested",
  retryCount: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const command = process.argv[2];
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19183";

if (!new Set(["write", "read", "reset"]).has(command)) {
  throw new Error("usage: npm run proof2:rpc -- <write|read|reset>");
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
  clientDisplayName: "dataops-guardian-proof2",
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

function findProofProjection(describeResult) {
  const row = describeResult.session;
  const projection = row?.pluginExtensions?.find(
    (extension) =>
      extension.pluginId === PLUGIN_ID && extension.namespace === NAMESPACE,
  );

  return { row, projection };
}

function assertState(actual, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expectedState)) {
    throw new Error(
      `${message}\nexpected=${JSON.stringify(expectedState)}\nactual=${JSON.stringify(actual)}`,
    );
  }
}

async function run() {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("gateway connect timeout")), 15_000),
    ),
  ]);

  if (command === "write") {
    await client.request("sessions.create", {
      key: SESSION_KEY,
      agentId: "main",
      label: "DataOps Guardian Proof 2",
    });

    const patchResult = await client.request("sessions.pluginPatch", {
      key: SESSION_KEY,
      pluginId: PLUGIN_ID,
      namespace: NAMESPACE,
      value: expectedState,
    });
    assertState(patchResult.value, "sessions.pluginPatch returned unexpected state");
  }

  if (command === "reset") {
    await client.request("sessions.reset", {
      key: SESSION_KEY,
      reason: "reset",
    });
  }

  const describeResult = await client.request("sessions.describe", {
    key: SESSION_KEY,
  });
  const { row, projection } = findProofProjection(describeResult);

  if (command === "reset") {
    if (projection !== undefined) {
      throw new Error("session extension projection still exists after reset");
    }
  } else {
    if (!row) {
      throw new Error(
        `session row ${SESSION_KEY} was not returned by sessions.describe`,
      );
    }
    if (!projection) {
      throw new Error("incident projection was not returned by sessions.describe");
    }
    assertState(
      projection.value,
      "sessions.describe returned unexpected projection",
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      command,
      ok: true,
      sessionKey: SESSION_KEY,
      projectionPresent: projection !== undefined,
    })}\n`,
  );
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
