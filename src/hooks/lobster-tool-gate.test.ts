import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildLobsterToolGateDecision,
  INCIDENT_WORKFLOW,
} from "./lobster-tool-gate.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

function runParams(overrides: Record<string, unknown> = {}) {
  return {
    action: "run",
    pipeline: INCIDENT_WORKFLOW,
    argsJson: JSON.stringify({
      alert_id: "incident-1",
      metric: "kubernetes_deployment_revision",
      action: "rollback_latest_release",
    }),
    cwd: ".",
    timeoutMs: 15_000,
    ...overrides,
  };
}

async function createResumeFixture(overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "guardian-lobster-gate-test-"));
  temporaryRoots.push(root);
  const stateDir = join(root, "lobster-state");
  const workflowPath = join(root, "workflows", "incident-remediation.lobster");
  const stateKey = "workflow_resume_12345678-1234-4123-8123-123456789abc";
  const token = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      v: 1,
      kind: "workflow-file",
      stateKey,
    }),
    "utf8",
  ).toString("base64url");
  const args = {
    alert_id: "incident-1",
    metric: "kubernetes_deployment_revision",
    action: "rollback_latest_release",
    guardian_root: root,
  };
  const prepare = {
    step: "prepare",
    alertId: args.alert_id,
    metric: args.metric,
    action: args.action,
    preview:
      "Synthetic execution plan: rollback_latest_release for incident-1.",
    mutatesProduction: false,
  };
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    join(stateDir, `${stateKey}.json`),
    `${JSON.stringify({
      filePath: workflowPath,
      resumeAtIndex: 2,
      steps: {
        prepare: {
          id: "prepare",
          stdout: `${JSON.stringify(prepare)}\n`,
          json: prepare,
        },
        confirm: {
          id: "confirm",
          stdout: JSON.stringify(prepare),
          json: prepare,
        },
      },
      approvalStepId: "confirm",
      args,
      approvalIdentity: {},
      createdAt: "2026-08-11T00:00:00.000Z",
      ...overrides,
    })}\n`,
  );
  return {
    root,
    stateDir,
    stateKey,
    workflowPath,
    params: {
      action: "resume",
      token,
      approve: true,
      cwd: ".",
      timeoutMs: 15_000,
    },
  };
}

describe("Lobster incident-workflow gate", () => {
  it("blocks run-identified Agent Lobster calls, including the baked workflow", async () => {
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: runParams(),
        runId: "agent-run-1",
      }),
    ).resolves.toMatchObject({ block: true, blockReason: expect.stringContaining("operator-only") });
  });

  it("blocks arbitrary inline shell pipelines for operator callers", async () => {
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: runParams({
          pipeline: "exec --shell 'printenv OPENCLAW_GATEWAY_TOKEN'",
        }),
      }),
    ).resolves.toMatchObject({
      block: true,
      blockReason: expect.stringContaining("immutable Guardian incident workflow"),
    });
  });

  it("allows only the exact baked run shape for trusted operator RPC", async () => {
    const decision = await buildLobsterToolGateDecision({
      rawConfig: {},
      toolParams: runParams(),
    });
    expect(decision).toMatchObject({
      params: {
        cwd: ".",
        pipeline: expect.stringMatching(/incident-remediation\.lobster$/),
      },
    });
    expect(
      JSON.parse(String(decision && "params" in decision
        ? decision.params.argsJson
        : "null")),
    ).toMatchObject({
      alert_id: "incident-1",
      metric: "kubernetes_deployment_revision",
      action: "rollback_latest_release",
      guardian_root: expect.any(String),
    });

    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: runParams({ extra: "not-allowed" }),
      }),
    ).resolves.toMatchObject({ block: true });
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: runParams({
          argsJson: JSON.stringify({
            alert_id: "incident-1",
            metric: "metric",
            action: "exec_arbitrary_command",
          }),
        }),
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("binds the workflow and step root independently of the Gateway cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "guardian-lobster-cwd-test-"));
    temporaryRoots.push(root);
    const pluginRoot = join(root, "outside-gateway", "dataops-guardian");
    const workflowPath = join(pluginRoot, INCIDENT_WORKFLOW);

    const decision = await buildLobsterToolGateDecision({
      rawConfig: {},
      toolParams: runParams(),
      expectedWorkflowPath: workflowPath,
    });
    expect(decision).toMatchObject({
      params: { cwd: ".", pipeline: workflowPath },
    });
    expect(
      JSON.parse(String(decision && "params" in decision
        ? decision.params.argsJson
        : "null")),
    ).toMatchObject({ guardian_root: pluginRoot });

    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: runParams(),
        expectedWorkflowPath: join(root, "unsupported|root", INCIDENT_WORKFLOW),
      }),
    ).resolves.toMatchObject({
      block: true,
      blockReason: expect.stringContaining("path is not supported"),
    });
  });

  it("allows resume only when the token resolves to the exact persisted workflow", async () => {
    const fixture = await createResumeFixture();
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: fixture.params,
        env: { LOBSTER_STATE_DIR: fixture.stateDir },
        expectedWorkflowPath: fixture.workflowPath,
      }),
    ).resolves.toEqual({ params: { cwd: "." } });
  });

  it("mirrors Lobster's default home-directory resume store", async () => {
    const fixture = await createResumeFixture();
    const defaultStateDir = join(fixture.root, ".lobster", "state");
    await mkdir(defaultStateDir, { recursive: true });
    await writeFile(
      join(defaultStateDir, `${fixture.stateKey}.json`),
      await readFile(join(fixture.stateDir, `${fixture.stateKey}.json`)),
    );

    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: fixture.params,
        env: {},
        homeDirectory: fixture.root,
        expectedWorkflowPath: fixture.workflowPath,
      }),
    ).resolves.toEqual({ params: { cwd: "." } });
  });

  it("blocks missing, malformed, and cross-workflow resume state", async () => {
    const fixture = await createResumeFixture({
      filePath: "/tmp/attacker-controlled.lobster",
    });
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: fixture.params,
        env: { LOBSTER_STATE_DIR: fixture.stateDir },
        expectedWorkflowPath: fixture.workflowPath,
      }),
    ).resolves.toMatchObject({ block: true });

    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: { ...fixture.params, token: "not-a-token" },
        env: { LOBSTER_STATE_DIR: fixture.stateDir },
        expectedWorkflowPath: fixture.workflowPath,
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("blocks tampered persisted step output and approval identity", async () => {
    const tamperedSteps = await createResumeFixture({
      steps: {
        prepare: {
          id: "prepare",
          stdout: '{"mutatesProduction":true}',
          json: { mutatesProduction: true },
        },
        confirm: {
          id: "confirm",
          stdout: '{"mutatesProduction":true}',
          json: { mutatesProduction: true },
        },
      },
    });
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: tamperedSteps.params,
        env: { LOBSTER_STATE_DIR: tamperedSteps.stateDir },
        expectedWorkflowPath: tamperedSteps.workflowPath,
      }),
    ).resolves.toMatchObject({ block: true });

    const tamperedIdentity = await createResumeFixture({
      approvalIdentity: { requiredApprover: "attacker-selected" },
    });
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: {},
        toolParams: tamperedIdentity.params,
        env: { LOBSTER_STATE_DIR: tamperedIdentity.stateDir },
        expectedWorkflowPath: tamperedIdentity.workflowPath,
      }),
    ).resolves.toMatchObject({ block: true });
  });

  it("permits an explicit test-only opt-out outside the release profile", async () => {
    await expect(
      buildLobsterToolGateDecision({
        rawConfig: { lobsterToolPolicyMode: "disabled" },
        toolParams: { action: "run", pipeline: "exec echo fixture" },
        runId: "fixture-run",
      }),
    ).resolves.toBeUndefined();
  });
});
