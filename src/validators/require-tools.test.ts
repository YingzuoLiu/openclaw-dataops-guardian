import { describe, expect, it } from "vitest";

import {
  evaluateRequireTools,
  normalizeRequireToolsConfig,
  recordToolCall,
  type RequireToolsValidatorConfig,
} from "./require-tools.js";

const config = {
  type: "require_tools",
  tools: ["search", "inspect"],
  maxAttempts: 1,
} satisfies RequireToolsValidatorConfig;

describe("require_tools validator", () => {
  it("fails deterministically when an Agent finalizes without Tool calls", () => {
    expect(evaluateRequireTools(config, undefined)).toEqual({
      valid: false,
      missingTools: ["search", "inspect"],
      attemptedButFailedTools: [],
    });
  });

  it("distinguishes failed attempts from tools never called", () => {
    const ledger = recordToolCall(undefined, {
      toolName: "search",
      succeeded: false,
    });

    expect(evaluateRequireTools(config, ledger)).toEqual({
      valid: false,
      missingTools: ["search", "inspect"],
      attemptedButFailedTools: ["search"],
    });
  });

  it("passes only after every configured Tool succeeds", () => {
    let ledger = recordToolCall(undefined, {
      toolName: "search",
      succeeded: true,
    });
    ledger = recordToolCall(ledger, {
      toolName: "inspect",
      succeeded: true,
    });

    expect(evaluateRequireTools(config, ledger)).toEqual({
      valid: true,
      missingTools: [],
      attemptedButFailedTools: [],
    });
  });

  it("rejects duplicate Tool names and unbounded retry values", () => {
    expect(() =>
      normalizeRequireToolsConfig({
        type: "require_tools",
        tools: ["search", "search"],
      }),
    ).toThrow("unique");
    expect(() =>
      normalizeRequireToolsConfig({
        type: "require_tools",
        tools: ["search"],
        maxAttempts: 0,
      }),
    ).toThrow("1 through 10");
  });
});
