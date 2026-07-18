import { describe, expect, it } from "vitest";

import { inspectMetricSnapshot } from "./inspect-metric-snapshot.js";

describe("inspectMetricSnapshot", () => {
  it("classifies a twenty percent decline as critical", () => {
    expect(
      inspectMetricSnapshot({
        alertId: "payment-success-rate-drop",
        metric: "payment_success_rate",
        currentValue: 0.76,
        baselineValue: 0.95,
        source: "prometheus:payment_success_rate",
      }),
    ).toMatchObject({
      relativeChange: -0.19999999999999996,
      classification: "critical",
      source: "prometheus:payment_success_rate",
    });
  });

  it("handles a zero baseline without dividing by zero", () => {
    expect(
      inspectMetricSnapshot({
        alertId: "new-error-series",
        metric: "error_count",
        currentValue: 8,
        baselineValue: 0,
      }),
    ).toMatchObject({
      relativeChange: null,
      classification: "within_expected_range",
      source: "supplied_snapshot",
    });
  });
});
