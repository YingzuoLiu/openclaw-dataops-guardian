import { Type, type Static } from "typebox";

export const RequireToolsValidatorSchema = Type.Object(
  {
    type: Type.Literal("require_tools"),
    tools: Type.Array(
      Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-zA-Z0-9_.:-]+$" }),
      { minItems: 1, maxItems: 32, uniqueItems: true },
    ),
    maxAttempts: Type.Optional(
      Type.Integer({ minimum: 1, maximum: 10, default: 1 }),
    ),
  },
  { additionalProperties: false },
);

export type RequireToolsValidatorConfig = Static<
  typeof RequireToolsValidatorSchema
>;

export type ToolCallLedger = {
  attemptedTools: string[];
  successfulTools: string[];
};

export type RequireToolsValidation = {
  valid: boolean;
  missingTools: string[];
  attemptedButFailedTools: string[];
};

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export function normalizeRequireToolsConfig(
  config: RequireToolsValidatorConfig,
): Required<RequireToolsValidatorConfig> {
  const tools = [...new Set(config.tools.map((tool) => tool.trim()))].filter(
    Boolean,
  );
  if (config.type !== "require_tools" || tools.length === 0) {
    throw new Error("require_tools validator needs at least one tool");
  }
  if (tools.length !== config.tools.length) {
    throw new Error("require_tools validator tool names must be unique and non-empty");
  }

  const maxAttempts = config.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
    throw new Error("require_tools maxAttempts must be an integer from 1 through 10");
  }

  return {
    type: "require_tools",
    tools,
    maxAttempts,
  };
}

export function readToolCallLedger(value: unknown): ToolCallLedger {
  const record = readRecord(value);
  return {
    attemptedTools: [...new Set(readStringArray(record?.attemptedTools))].sort(),
    successfulTools: [...new Set(readStringArray(record?.successfulTools))].sort(),
  };
}

export function recordToolCall(
  current: unknown,
  observation: { toolName: string; succeeded: boolean },
): ToolCallLedger {
  const ledger = readToolCallLedger(current);
  const attemptedTools = new Set(ledger.attemptedTools);
  const successfulTools = new Set(ledger.successfulTools);

  attemptedTools.add(observation.toolName);
  if (observation.succeeded) {
    successfulTools.add(observation.toolName);
  }

  return {
    attemptedTools: [...attemptedTools].sort(),
    successfulTools: [...successfulTools].sort(),
  };
}

export function evaluateRequireTools(
  config: RequireToolsValidatorConfig,
  ledgerValue: unknown,
): RequireToolsValidation {
  const normalized = normalizeRequireToolsConfig(config);
  const ledger = readToolCallLedger(ledgerValue);
  const attempted = new Set(ledger.attemptedTools);
  const successful = new Set(ledger.successfulTools);
  const missingTools = normalized.tools.filter((tool) => !successful.has(tool));

  return {
    valid: missingTools.length === 0,
    missingTools,
    attemptedButFailedTools: missingTools.filter((tool) => attempted.has(tool)),
  };
}
