import { readFile, writeFile } from "node:fs/promises";

import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";

import {
  openIncident,
  recordApprovalDecision,
  recordMetricEvidence,
  recordRecoveryCheck,
  recordRemediationExecution,
  recordRemediationProposal,
} from "../dist/state/incident-workflow.js";

const PLUGIN_ID = "dataops-guardian";
const NAMESPACE = "incident";
const SESSION_KEY =
  process.env.OPENCLAW_VERTICAL_SESSION_KEY ??
  "agent:main:dataops-guardian-vertical-slice";
const RESUME_FILE =
  process.env.OPENCLAW_VERTICAL_RESUME_FILE ??
  ".openclaw-proof/vertical-slice-resume.json";
const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT ?? "19183";
const command = process.argv[2];
const decision = process.argv[3];

if (!new Set(["start", "resume", "show"]).has(command)) {
  throw new Error("usage: npm run slice:rpc -- <start|resume|show> [approve|deny]");
}
if (command === "resume" && !new Set(["approve", "deny"]).has(decision)) {
  throw new Error("resume requires an approve or deny decision");
}
if (!GATEWAY_TOKEN) {
  throw new Error("OPENCLAW_GATEWAY_TOKEN is required");
}

let resolveReady;
let rejectReady;
const ready = new Promise((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});

const client = new GatewayClient({
  url: `ws://127.0.0.1:${GATEWAY_PORT}`,
  token: GATEWAY_TOKEN,
  clientName: "openclaw-tui",
  clientDisplayName: "dataops-guardian-vertical-slice",
  clientVersion: "2026.6.9",
  platform: process.platform,
  mode: "ui",
  role: "operator",
  scopes: ["operator.admin", "operator.read", "operator.write"],
  deviceIdentity: null,
  requestTimeoutMs: 20_000,
  onHelloOk: resolveReady,
  onConnectError: rejectReady,
});

function now() {
  return new Date().toISOString();
}

async function patchState(state) {
  const result = await client.request("sessions.pluginPatch", {
    key: SESSION_KEY,
    pluginId: PLUGIN_ID,
    namespace: NAMESPACE,
    value: state,
  });

  if (JSON.stringify(result.value) !== JSON.stringify(state)) {
    throw new Error("Gateway returned an unexpected incident state after patch");
  }
}

async function readState() {
  const result = await client.request("sessions.describe", { key: SESSION_KEY });
  const projection = result.session?.pluginExtensions?.find(
    (entry) =>
      entry.pluginId === PLUGIN_ID && entry.namespace === NAMESPACE,
  );

  if (!projection?.value) {
    throw new Error(`incident state is missing for ${SESSION_KEY}`);
  }
  return projection.value;
}

async function invokeTool(name, args) {
  const invocation = await client.request("tools.invoke", {
    name,
    args,
    sessionKey: SESSION_KEY,
  });

  if (invocation.ok !== true) {
    throw new Error(`${name} failed: ${JSON.stringify(invocation)}`);
  }
  return invocation.output?.details;
}

async function startSlice() {
  const alertBase = {
    alertId: "payment-success-rate-drop",
    metric: "payment_success_rate",
    baselineValue: 1,
  };
  const prometheusQuery =
    'payment_success_rate{service="payments",environment="proof"}';

  await client.request("sessions.create", {
    key: SESSION_KEY,
    agentId: "main",
    label: `DataOps Guardian: ${SESSION_KEY.split(":").at(-1)}`,
  });

  const prometheus = await invokeTool("guardian_query_prometheus", {
    query: prometheusQuery,
  });
  const alert = {
    ...alertBase,
    currentValue: prometheus.currentValue,
  };

  let state = openIncident({
    alertId: alert.alertId,
    occurredAt: prometheus.observedAt,
  });
  await patchState(state);

  const metricResult = await invokeTool(
    "guardian_inspect_metric_snapshot",
    { ...alert, source: `prometheus:${prometheus.query}` },
  );
  state = recordMetricEvidence(state, metricResult, prometheus.observedAt);
  await patchState(state);

  const proposal = await invokeTool("guardian_propose_remediation", {
    alertId: alert.alertId,
    metric: alert.metric,
    classification: metricResult.classification,
  });
  state = recordRemediationProposal(state, proposal, now());
  await patchState(state);

  const lobster = await invokeTool("lobster", {
    action: "run",
    pipeline: "workflows/incident-remediation.lobster",
    argsJson: JSON.stringify({
      alert_id: alert.alertId,
      metric: alert.metric,
      action: proposal.action,
    }),
    cwd: ".",
    timeoutMs: 15_000,
  });
  const resumeToken = lobster?.requiresApproval?.resumeToken;

  if (lobster?.status !== "needs_approval" || !resumeToken) {
    throw new Error(`Lobster did not pause for approval: ${JSON.stringify(lobster)}`);
  }

  await writeFile(
    RESUME_FILE,
    `${JSON.stringify(
      {
        sessionKey: SESSION_KEY,
        alert,
        proposal,
        resumeToken,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    ok: true,
    command: "start",
    sessionKey: SESSION_KEY,
    stage: state.stage,
    classification: metricResult.classification,
    currentValue: prometheus.currentValue,
    metricSource: "prometheus",
    proposedAction: state.proposedAction,
    approvalStatus: state.approvalStatus,
    workflowStatus: lobster.status,
  };
}

async function resumeSlice() {
  const record = JSON.parse(await readFile(RESUME_FILE, "utf8"));
  const approved = decision === "approve";
  let state = await readState();

  state = recordApprovalDecision(state, approved, now());
  await patchState(state);

  const lobster = await invokeTool("lobster", {
    action: "resume",
    token: record.resumeToken,
    approve: approved,
    cwd: ".",
    timeoutMs: 15_000,
  });

  const expectedWorkflowStatus = approved ? "ok" : "cancelled";
  if (lobster?.status !== expectedWorkflowStatus) {
    throw new Error(`Lobster resume failed: ${JSON.stringify(lobster)}`);
  }

  if (approved) {
    state = recordRemediationExecution(
      state,
      `Synthetic remediation ${state.proposedAction} executed successfully.`,
      now(),
    );
    await patchState(state);

    state = recordRecoveryCheck(state, {
      healthy: true,
      summary: `${record.alert.metric} recovered in the synthetic post-remediation check.`,
      checkedAt: now(),
    });
    await patchState(state);
  }

  const persistedState = await readState();
  return {
    ok: true,
    command: "resume",
    decision,
    sessionKey: SESSION_KEY,
    stage: persistedState.stage,
    approvalStatus: persistedState.approvalStatus,
    proposedAction: persistedState.proposedAction,
    evidenceCount: persistedState.evidence.length,
    workflowStatus: lobster.status,
  };
}

async function run() {
  client.start();
  await Promise.race([
    ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("gateway connect timeout")), 15_000),
    ),
  ]);

  const result =
    command === "start"
      ? await startSlice()
      : command === "resume"
        ? await resumeSlice()
        : { ok: true, command: "show", state: await readState() };

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await run();
} finally {
  await client.stopAndWait({ timeoutMs: 2_000 });
}
