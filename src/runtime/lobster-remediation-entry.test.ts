import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { reduceAlertDelivery } from "../state/incident-reducer.js";
import type { IncidentState } from "../state/incident-state.js";
import {
  buildLobsterApprovalResumeRequest,
  buildLobsterApprovalRunRequest,
} from "./lobster-approval-payload.js";
import { authorizeRemediationWithLobster } from "./lobster-remediation-entry.js";

function pendingApproval(): IncidentState {
  const at = "2026-08-04T00:00:00.000Z";
  const created = reduceAlertDelivery(undefined, {
    alertId: "step3-entry-test",
    fingerprint: "step3-entry-test",
    alertStatus: "firing",
    startsAt: at,
    endsAt: null,
    receivedAt: at,
    deliveryId: "delivery-1",
  });
  if (!created.state) {
    throw new Error("fixture incident was not created");
  }
  return {
    ...created.state,
    stage: "approval",
    proposedAction: "kubernetes_deployment_rollback",
    approvalStatus: "pending",
    evidenceValidation: { status: "passed", checkedAt: at, issues: [] },
  };
}

describe("authorizeRemediationWithLobster", () => {
  it("sends relative in-root cwd values in the proof's run and resume payloads", async () => {
    const captured: unknown[] = [];
    const fakeGatewayClient = {
      request: async (_method: string, payload: unknown) => {
        captured.push(structuredClone(payload));
      },
    };
    const gatewayRoot = "/tmp/fake-step3-gateway-root";

    await fakeGatewayClient.request(
      "tools.invoke",
      buildLobsterApprovalRunRequest("agent:main:test", "occurrence-1"),
    );
    await fakeGatewayClient.request(
      "tools.invoke",
      buildLobsterApprovalResumeRequest("agent:main:test", "resume-token-1"),
    );

    expect(captured).toHaveLength(2);
    for (const payload of captured as Array<{ args: { cwd: string } }>) {
      expect(payload.args.cwd).toBe(".");
      expect(path.isAbsolute(payload.args.cwd)).toBe(false);
      const resolved = path.resolve(gatewayRoot, payload.args.cwd);
      const relative = path.relative(gatewayRoot, resolved);
      expect(relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))).toBe(
        true,
      );
      expect(payload.args.cwd).not.toBe(process.cwd());
    }
  });

  it("persists pending, approved, and running checkpoints around real approval", async () => {
    const persisted: IncidentState[] = [];
    const requestApproval = vi.fn(async () => ({
      approved: true,
      workflowStatus: "ok",
    }));

    const result = await authorizeRemediationWithLobster({
      sessionKey: "agent:main:step3-entry-test",
      approvalState: pendingApproval(),
      idempotencyKey: "attempt-1",
      target: { kind: "synthetic" },
      decidedAt: "2026-08-04T00:00:01.000Z",
      startedAt: "2026-08-04T00:00:02.000Z",
      writer: {
        persistIncidentState: async (_sessionKey, state) => {
          persisted.push(structuredClone(state));
        },
      },
      requestApproval,
    });

    expect(requestApproval).toHaveBeenCalledOnce();
    expect(result.decision).toBe("started");
    expect(persisted.map((state) => [state.stage, state.approvalStatus])).toEqual([
      ["approval", "pending"],
      ["remediation", "approved"],
      ["remediation", "approved"],
    ]);
    expect(persisted[2]?.remediationAttempts).toMatchObject([
      { idempotencyKey: "attempt-1", status: "running" },
    ]);
  });

  it("keeps the kind proof on the production entry and away from direct state synthesis", async () => {
    const proof = await readFile(
      new URL("../../scripts/kind-deployment-rollback-rpc.mjs", import.meta.url),
      "utf8",
    );

    expect(proof).toContain("authorizeRemediationWithLobster");
    expect(proof).toContain("GatewayIncidentClient");
    expect(proof).not.toContain("recordApprovalDecision");
    expect(proof).not.toContain("beginRemediationAttempt");
    expect(proof).not.toContain('client.request("sessions.pluginPatch"');
  });
});
