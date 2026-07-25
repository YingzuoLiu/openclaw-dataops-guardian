import { describe, expect, it } from "vitest";

import plugin from "./index.js";

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
}) {
  const hooks = new Map<string, RegisteredHook>();
  const runContexts = new Map<string, unknown>();
  const logs: string[] = [];

  const api = {
    pluginConfig: {
      enforceRequireToolsOnAgentRuns:
        options?.enforceRequireToolsOnAgentRuns ?? false,
      requireToolsGateMode: options?.requireToolsGateMode,
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
