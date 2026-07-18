import { describe, expect, it } from "vitest";

import { proposeRemediation } from "./propose-remediation.js";

describe("proposeRemediation", () => {
  it("proposes a rollback for a critical regression", () => {
    expect(
      proposeRemediation({
        alertId: "payment-success-rate-drop",
        metric: "payment_success_rate",
        classification: "critical",
      }),
    ).toMatchObject({
      action: "rollback_latest_release",
      risk: "high",
    });
  });

  it("does not propose a mutation for a healthy metric", () => {
    expect(
      proposeRemediation({
        alertId: "payment-success-rate-drop",
        metric: "payment_success_rate",
        classification: "within_expected_range",
      }),
    ).toMatchObject({
      action: "no_change_continue_observation",
      risk: "low",
    });
  });
});
