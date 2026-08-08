import { describe, expect, it } from "vitest";

import { extractGuardianAuditEvents } from "./gateway-audit-log.mjs";

function auditEvent(hook, decision) {
  return {
    schemaVersion: 1,
    component: "dataops-guardian",
    event: "require_tools",
    hook,
    runId: "guardian-live-hook-proof:test",
    decision,
    requiredTools: ["guardian_query_prometheus"],
  };
}

describe("Gateway audit log extraction", () => {
  it("extracts events separated by physical log lines", () => {
    const activation = auditEvent("before_agent_run", "activate");
    const revision = auditEvent("before_agent_finalize", "revise");
    const log = [
      `2026-08-08 [plugins] ${JSON.stringify(activation)}`,
      "2026-08-08 [gateway] unrelated message",
      `2026-08-08 [plugins] ${JSON.stringify(revision)}`,
    ].join("\n");

    expect(extractGuardianAuditEvents(log)).toEqual([activation, revision]);
  });

  it("extracts consecutive events separated by an escaped newline", () => {
    const activation = auditEvent("before_agent_run", "activate");
    const revision = auditEvent("before_agent_finalize", "revise");
    const log =
      `2026-08-08 [plugins] ${JSON.stringify(activation)}` +
      `\\n2026-08-08 [plugins] ${JSON.stringify(revision)}`;

    expect(extractGuardianAuditEvents(log)).toEqual([activation, revision]);
  });

  it("does not terminate early on braces inside JSON strings", () => {
    const event = {
      ...auditEvent("before_agent_run", "activate"),
      detail: 'literal } and { plus "quoted" text',
    };

    expect(
      extractGuardianAuditEvents(`2026-08-08 [plugins] ${JSON.stringify(event)}`),
    ).toEqual([event]);
  });

  it("supports Gateway logs that escape the complete event", () => {
    const event = auditEvent("before_agent_finalize", "revise");
    const encoded = JSON.stringify(event).replaceAll('"', '\\"');

    expect(extractGuardianAuditEvents(`message=${encoded}`)).toEqual([event]);
  });
});
