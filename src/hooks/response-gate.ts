import {
  evaluateRequireTools,
  normalizeRequireToolsConfig,
  readToolCallLedger,
  recordToolCall,
  type RequireToolsValidatorConfig,
  type ToolCallLedger,
} from "../validators/require-tools.js";

export const GUARDIAN_RUN_CONTEXT_NAMESPACE = "evidence-tools";
export const GUARDIAN_REQUIRE_TOOLS = {
  type: "require_tools",
  tools: [
    "guardian_query_prometheus",
    "guardian_inspect_metric_snapshot",
  ],
  maxAttempts: 1,
} satisfies RequireToolsValidatorConfig;

const GUARDIAN_TOOL_PREFIX = "guardian_";

export type GuardianRunEvidence = {
  active: true;
  ledger: ToolCallLedger;
};

export type ResponseGateDecision = {
  action: "revise";
  reason: string;
  retry: {
    instruction: string;
    idempotencyKey: string;
    maxAttempts: number;
  };
};

export type ProposalToolGateDecision = {
  block: true;
  blockReason: string;
};

export type GuardianGateAuditEvent = {
  schemaVersion: 1;
  component: "dataops-guardian";
  event: "require_tools";
  hook: "before_agent_run" | "before_tool_call" | "before_agent_finalize";
  runId: string;
  decision: "activate" | "allow" | "block" | "revise";
  requiredTools: string[];
  missingTools: string[];
  attemptedButFailedTools: string[];
  recordedAt: string;
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readLedger(value: unknown): ToolCallLedger {
  return readToolCallLedger(readRecord(value)?.ledger);
}

export function shouldEnforceGuardianRequireTools(rawConfig: unknown): boolean {
  return readRecord(rawConfig)?.enforceRequireToolsOnAgentRuns === true;
}

export function activateGuardianRunEvidence(
  current: unknown,
): GuardianRunEvidence {
  return {
    active: true,
    ledger: readLedger(current),
  };
}

export function recordGuardianToolObservation(
  current: unknown,
  params: { toolName: string; succeeded: boolean },
): GuardianRunEvidence | undefined {
  if (!params.toolName.startsWith(GUARDIAN_TOOL_PREFIX)) {
    return undefined;
  }

  return {
    active: true,
    ledger: recordToolCall(readLedger(current), params),
  };
}

export function evaluateAgentEvidenceTools(state: unknown): {
  active: boolean;
  missingTools: string[];
  attemptedButFailedTools: string[];
} {
  const record = readRecord(state);
  if (record?.active !== true) {
    return { active: false, missingTools: [], attemptedButFailedTools: [] };
  }

  const validation = evaluateRequireTools(GUARDIAN_REQUIRE_TOOLS, readLedger(state));
  return {
    active: true,
    missingTools: validation.missingTools,
    attemptedButFailedTools: validation.attemptedButFailedTools,
  };
}

export function buildGuardianGateAuditEvent(params: {
  state: unknown;
  hook: GuardianGateAuditEvent["hook"];
  runId: string;
  decision: GuardianGateAuditEvent["decision"];
  recordedAt?: string;
}): GuardianGateAuditEvent {
  const evaluation = evaluateAgentEvidenceTools(params.state);
  return {
    schemaVersion: 1,
    component: "dataops-guardian",
    event: "require_tools",
    hook: params.hook,
    runId: params.runId,
    decision: params.decision,
    requiredTools: [...GUARDIAN_REQUIRE_TOOLS.tools],
    missingTools: evaluation.active
      ? evaluation.missingTools
      : [...GUARDIAN_REQUIRE_TOOLS.tools],
    attemptedButFailedTools: evaluation.attemptedButFailedTools,
    recordedAt: params.recordedAt ?? new Date().toISOString(),
  };
}

export function buildResponseGateDecision(
  state: unknown,
): ResponseGateDecision | undefined {
  const evaluation = evaluateAgentEvidenceTools(state);
  if (!evaluation.active || evaluation.missingTools.length === 0) {
    return undefined;
  }

  const missing = evaluation.missingTools.join(", ");
  const instruction =
    `Guardian evidence validation failed. Before concluding, successfully call: ${missing}. ` +
    "Use the returned source and observedAt in the revised conclusion. If evidence cannot be obtained, explicitly report the incident as blocked instead of asserting a diagnosis.";

  return {
    action: "revise",
    reason: `DataOps conclusion is missing required tool evidence: ${missing}`,
    retry: {
      instruction,
      idempotencyKey: `dataops-guardian:require-tools:${evaluation.missingTools.join("+")}`,
      maxAttempts: normalizeRequireToolsConfig(GUARDIAN_REQUIRE_TOOLS).maxAttempts,
    },
  };
}

export function buildProposalToolGateDecision(
  state: unknown,
): ProposalToolGateDecision | undefined {
  const evaluation = evaluateAgentEvidenceTools(state);
  const missingTools = evaluation.active
    ? evaluation.missingTools
    : [...GUARDIAN_REQUIRE_TOOLS.tools];
  if (missingTools.length === 0) {
    return undefined;
  }

  return {
    block: true,
    blockReason: `remediation proposal requires successful evidence tools: ${missingTools.join(", ")}`,
  };
}
