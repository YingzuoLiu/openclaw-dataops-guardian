export const GUARDIAN_RUN_CONTEXT_NAMESPACE = "evidence-tools";
export const REQUIRED_AGENT_EVIDENCE_TOOLS = [
  "guardian_query_prometheus",
  "guardian_inspect_metric_snapshot",
] as const;

const GUARDIAN_TOOL_PREFIX = "guardian_";

export type GuardianRunEvidence = {
  active: true;
  successfulTools: string[];
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

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readSuccessfulTools(value: unknown): string[] {
  const state = readRecord(value);
  return Array.isArray(state?.successfulTools)
    ? state.successfulTools.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
}

export function recordGuardianToolObservation(
  current: unknown,
  params: { toolName: string; succeeded: boolean },
): GuardianRunEvidence | undefined {
  if (!params.toolName.startsWith(GUARDIAN_TOOL_PREFIX)) {
    return undefined;
  }

  const successfulTools = new Set(readSuccessfulTools(current));
  if (params.succeeded) {
    successfulTools.add(params.toolName);
  }

  return {
    active: true,
    successfulTools: [...successfulTools].sort(),
  };
}

export function evaluateAgentEvidenceTools(state: unknown): {
  active: boolean;
  missingTools: string[];
} {
  const record = readRecord(state);
  if (record?.active !== true) {
    return { active: false, missingTools: [] };
  }

  const successfulTools = new Set(readSuccessfulTools(state));
  return {
    active: true,
    missingTools: REQUIRED_AGENT_EVIDENCE_TOOLS.filter(
      (toolName) => !successfulTools.has(toolName),
    ),
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
      maxAttempts: 1,
    },
  };
}

export function buildProposalToolGateDecision(
  state: unknown,
): ProposalToolGateDecision | undefined {
  const evaluation = evaluateAgentEvidenceTools(state);
  const missingTools = evaluation.active
    ? evaluation.missingTools
    : [...REQUIRED_AGENT_EVIDENCE_TOOLS];
  if (missingTools.length === 0) {
    return undefined;
  }

  return {
    block: true,
    blockReason: `remediation proposal requires successful evidence tools: ${missingTools.join(", ")}`,
  };
}
