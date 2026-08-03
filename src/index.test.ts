import { describe, expect, it } from "vitest";

import plugin from "./index.js";
import { reduceAlertDelivery } from "./state/incident-reducer.js";
import {
  beginRemediationAttempt,
  recordApprovalDecision,
  recordMetricEvidence,
  recordRemediationProposal,
} from "./state/incident-workflow.js";
import type { RemediationTarget } from "./state/incident-state.js";
import { inspectMetricSnapshot } from "./tools/inspect-metric-snapshot.js";
import { proposeRemediation } from "./tools/propose-remediation.js";

type RegisteredHook = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => unknown;

function createPluginHarness(options?: {
  enforceRequireToolsOnAgentRuns?: boolean;
  requireToolsGateMode?:
    | "disabled"
    | "on_guardian_tool"
    | "all_agent_runs";
  rejectRunContextWrites?: boolean;
  kubernetesConfig?: unknown;
}) {
  const hooks = new Map<string, RegisteredHook>();
  const runContexts = new Map<string, unknown>();
  const logs: string[] = [];

  const api = {
    pluginConfig: {
      enforceRequireToolsOnAgentRuns:
        options?.enforceRequireToolsOnAgentRuns ?? false,
      requireToolsGateMode: options?.requireToolsGateMode,
      kubernetes: options?.kubernetesConfig,
    },
    registerTool: () => undefined,
    registerToolMetadata: () => undefined,
    on: (name: string, handler: RegisteredHook) => {
      hooks.set(name, handler);
    },
    runContext: {
      getRunContext: (params: { runId: string; namespace: string }) =>
        runContexts.get(`${params.runId}:${params.namespace}`),
      setRunContext: (params: {
        runId: string;
        namespace: string;
        value: unknown;
      }) => {
        if (options?.rejectRunContextWrites) {
          return false;
        }
        runContexts.set(`${params.runId}:${params.namespace}`, params.value);
        return true;
      },
      clearRunContext: (params: { runId: string; namespace: string }) => {
        runContexts.delete(`${params.runId}:${params.namespace}`);
      },
    },
    session: {
      state: {
        registerSessionExtension: () => undefined,
      },
    },
    logger: {
      info: (message: string) => logs.push(message),
      warn: () => undefined,
      error: () => undefined,
    },
  };

  if (!plugin.register) {
    throw new Error("DataOps Guardian plugin is missing its register function");
  }
  plugin.register(api as never);
  return { hooks, logs };
}

describe("DataOps Guardian plugin hook wiring", () => {
  it("rejects unsupported incident schemas at the Tool boundary", async () => {
    const { hooks } = createPluginHarness({
      requireToolsGateMode: "disabled",
    });

    const decision = await hooks.get("before_tool_call")?.(
      {
        runId: "run-schema-v2",
        toolName: "guardian_propose_remediation",
      },
      {
        runId: "run-schema-v2",
        getSessionExtension: () => ({
          schemaVersion: 2,
          alertId: "legacy-alert",
        }),
      },
    );

    expect(decision).toEqual({
      block: true,
      blockReason:
        "remediation proposal cannot read incident state: unsupported_schema",
    });
  });

  it("blocks guardian_rollback_deployment when there is no persisted incident state", async () => {
    const { hooks } = createPluginHarness({
      requireToolsGateMode: "disabled",
    });

    const decision = await hooks.get("before_tool_call")?.(
      {
        runId: "run-rollback",
        toolName: "guardian_rollback_deployment",
        params: {
          idempotencyKey: "attempt-1",
          target: { type: "kubernetes_deployment_rollback_v1" },
        },
      },
      {
        runId: "run-rollback",
        getSessionExtension: () => undefined,
      },
    );

    expect(decision).toEqual({
      block: true,
      blockReason:
        "guardian_rollback_deployment requires persisted incident state",
    });
  });

  it("blocks guardian_rollback_deployment for a target outside the administrator allowlist", async () => {
    const { hooks } = createPluginHarness({
      requireToolsGateMode: "disabled",
      kubernetesConfig: {
        clusterId: "guardian-step3-kind",
        kubeconfigPath: "/etc/guardian/kubeconfig",
        allowlist: [{ namespace: "guardian-step3", deployment: "payments-step3" }],
      },
    });
    const target: RemediationTarget = {
      type: "kubernetes_deployment_rollback_v1",
      clusterId: "guardian-step3-kind",
      namespace: "default",
      deployment: "other-deployment",
      deploymentUid: "deployment-uid-1",
      fromRevision: 2,
      toRevision: 1,
      fromTemplateSha256: "1".repeat(64),
      toTemplateSha256: "2".repeat(64),
    };
    const at = "2026-08-03T00:00:00.000Z";
    const created = reduceAlertDelivery(undefined, {
      alertId: "alert-1",
      fingerprint: "fingerprint-1",
      alertStatus: "firing",
      startsAt: at,
      endsAt: null,
      receivedAt: at,
      deliveryId: "delivery-1",
    });
    if (!created.state) {
      throw new Error("fixture incident was not created");
    }
    const metric = inspectMetricSnapshot({
      alertId: "alert-1",
      metric: "payment_success_rate",
      currentValue: 0.7,
      baselineValue: 1,
      source: "prometheus:payment_success_rate",
    });
    const proposal = proposeRemediation({
      alertId: "alert-1",
      metric: "payment_success_rate",
      classification: metric.classification,
    });
    let state = recordMetricEvidence(created.state, metric, at);
    state = recordRemediationProposal(state, proposal, at);
    state = recordApprovalDecision(state, true, at);
    const started = beginRemediationAttempt(state, {
      idempotencyKey: "attempt-1",
      target,
      startedAt: at,
    });
    if (started.decision !== "started") {
      throw new Error(`fixture attempt did not start: ${started.decision}`);
    }

    const decision = await hooks.get("before_tool_call")?.(
      {
        runId: "run-rollback",
        toolName: "guardian_rollback_deployment",
        params: { idempotencyKey: "attempt-1", target },
      },
      {
        runId: "run-rollback",
        getSessionExtension: () => started.state,
      },
    );

    expect(decision).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("outside the administrator allowlist"),
    });
  });

  it("activates require_tools before a dedicated Agent run starts", async () => {
    const { hooks, logs } = createPluginHarness({
      enforceRequireToolsOnAgentRuns: true,
    });

    expect([...hooks.keys()].sort()).toEqual([
      "after_tool_call",
      "agent_end",
      "before_agent_finalize",
      "before_agent_run",
      "before_tool_call",
    ]);

    await hooks.get("before_agent_run")?.({}, { runId: "run-zero-tools" });
    const decision = await hooks
      .get("before_agent_finalize")
      ?.({ runId: "run-zero-tools" }, { runId: "run-zero-tools" });

    expect(decision).toMatchObject({
      action: "revise",
      retry: { maxAttempts: 1 },
    });
    expect(logs.map((line) => JSON.parse(line))).toMatchObject([
      { hook: "before_agent_run", decision: "activate" },
      { hook: "before_agent_finalize", decision: "revise" },
    ]);
  });

  it("leaves unrelated runs untouched when the opt-in is disabled", async () => {
    const { hooks, logs } = createPluginHarness();

    await hooks.get("before_agent_run")?.({}, { runId: "run-unrelated" });
    const decision = await hooks
      .get("before_agent_finalize")
      ?.({ runId: "run-unrelated" }, { runId: "run-unrelated" });

    expect(decision).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("provides a true gate-off arm for controlled A/B evaluation", async () => {
    const { hooks, logs } = createPluginHarness({
      requireToolsGateMode: "disabled",
    });

    await hooks.get("before_agent_run")?.({}, { runId: "run-baseline" });
    await hooks.get("before_tool_call")?.(
      { runId: "run-baseline", toolName: "guardian_query_prometheus" },
      { runId: "run-baseline" },
    );
    await hooks.get("after_tool_call")?.(
      {
        runId: "run-baseline",
        toolName: "guardian_query_prometheus",
      },
      { runId: "run-baseline" },
    );
    const decision = await hooks
      .get("before_agent_finalize")
      ?.({ runId: "run-baseline" }, { runId: "run-baseline" });

    expect(decision).toBeUndefined();
    expect(logs).toEqual([]);
  });

  it("keeps enforcing through a bounded fallback when the host rejects run state", async () => {
    const { hooks, logs } = createPluginHarness({
      enforceRequireToolsOnAgentRuns: true,
      rejectRunContextWrites: true,
    });

    const activation = await hooks
      .get("before_agent_run")
      ?.({}, { runId: "run-rejected" });
    const decision = await hooks
      .get("before_agent_finalize")
      ?.({ runId: "run-rejected" }, { runId: "run-rejected" });

    expect(activation).toBeUndefined();
    expect(decision).toMatchObject({
      action: "revise",
      retry: { maxAttempts: 1 },
    });
    expect(logs.map((line) => JSON.parse(line))).toMatchObject([
      { hook: "before_agent_run", decision: "activate" },
      { hook: "before_agent_finalize", decision: "revise" },
    ]);
  });
});
