import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import {
  createIncidentOccurrenceId,
  readIncidentStateV3,
} from "../dist/state/incident-state.js";

const SESSION_KEY = "agent:main:dataops-guardian-state-v3-restart";
const PLUGIN_ID = "dataops-guardian";
const NAMESPACE = "incident";
const startsAt = "2026-07-25T00:00:00.000Z";
const recentDeliveryIds = Array.from(
  { length: 50 },
  (_, index) => `delivery-${index + 3}`,
);

const expectedState = {
  schemaVersion: 3,
  alertId: "state-v3-restart-proof",
  fingerprint: "state-v3-restart-fingerprint",
  occurrenceId: createIncidentOccurrenceId(
    "state-v3-restart-fingerprint",
    startsAt,
  ),
  alertStatus: "firing",
  startsAt,
  endsAt: null,
  lastReceivedAt: "2026-07-25T00:02:00.000Z",
  deliveryCount: 55,
  nonDuplicateDeliveryCount: 52,
  recentDeliveryIds,
  stage: "remediation",
  evidence: [
    {
      source: "prometheus:state_v3_restart_fixture",
      observedAt: "2026-07-25T00:01:00.000Z",
      summary: "Fresh synthetic evidence for the state restart proof.",
    },
  ],
  proposedAction: "rollback_latest_release",
  approvalStatus: "approved",
  remediationAttempts: [
    {
      idempotencyKey: "attempt-1",
      target: {
        kind: "synthetic",
        action: "rollback_latest_release",
        nested: { revision: 1, flags: [true, null] },
      },
      status: "succeeded",
      startedAt: "2026-07-25T00:03:00.000Z",
      finishedAt: "2026-07-25T00:04:00.000Z",
      error: null,
    },
    {
      idempotencyKey: "attempt-2",
      target: {
        kind: "synthetic",
        action: "rollback_latest_release",
        nested: { revision: 2, flags: [false] },
      },
      status: "failed",
      startedAt: "2026-07-25T00:05:00.000Z",
      finishedAt: "2026-07-25T00:06:00.000Z",
      error: "Synthetic execution failure.",
    },
    {
      idempotencyKey: "attempt-3",
      target: {
        kind: "synthetic",
        action: "rollback_latest_release",
        nested: { revision: 3, flags: [] },
      },
      status: "running",
      startedAt: "2026-07-25T00:07:00.000Z",
      finishedAt: null,
      error: null,
    },
  ],
  evidenceValidation: {
    status: "passed",
    checkedAt: "2026-07-25T00:02:00.000Z",
    issues: [],
  },
  updatedAt: "2026-07-25T00:07:00.000Z",
};

const decodedFixture = readIncidentStateV3(expectedState);
if (!decodedFixture.ok) {
  throw new Error(
    `invalid state-v3 restart fixture: ${decodedFixture.issues.join("; ")}`,
  );
}

const command = process.argv[2];
const token = process.env.OPENCLAW_GATEWAY_TOKEN;
const port = process.env.OPENCLAW_GATEWAY_PORT ?? "19184";

if (!new Set(["write", "read"]).has(command)) {
  throw new Error("usage: npm run state:v3:rpc -- <write|read>");
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
  clientDisplayName: "dataops-guardian-state-v3-restart",
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

function readProjection(result) {
  return result.session?.pluginExtensions?.find(
    (extension) =>
      extension.pluginId === PLUGIN_ID && extension.namespace === NAMESPACE,
  )?.value;
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}\nexpected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`,
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
      label: "DataOps Guardian IncidentState v3 restart proof",
    });
    const patched = await client.request("sessions.pluginPatch", {
      key: SESSION_KEY,
      pluginId: PLUGIN_ID,
      namespace: NAMESPACE,
      value: expectedState,
    });
    assertDeepEqual(
      patched.value,
      expectedState,
      "sessions.pluginPatch changed the v3 state",
    );
  }

  const described = await client.request("sessions.describe", {
    key: SESSION_KEY,
  });
  const projected = readProjection(described);
  assertDeepEqual(
    projected,
    expectedState,
    "sessions.describe did not return the complete v3 state",
  );
  const decoded = readIncidentStateV3(projected);
  if (!decoded.ok) {
    throw new Error(
      `persisted v3 state failed decoder validation: ${decoded.error}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      command,
      sessionKey: SESSION_KEY,
      deliveryCount: decoded.state.deliveryCount,
      recentDeliveryIds: decoded.state.recentDeliveryIds.length,
      remediationAttempts: decoded.state.remediationAttempts.length,
    })}\n`,
  );
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
