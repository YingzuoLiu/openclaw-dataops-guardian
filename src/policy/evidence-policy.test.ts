import { describe, expect, it } from "vitest";

import { evaluateIncidentEvidence } from "./evidence-policy.js";

const checkedAt = "2026-07-18T00:05:00.000Z";

describe("evaluateIncidentEvidence", () => {
  it("accepts fresh Prometheus evidence", () => {
    expect(
      evaluateIncidentEvidence(
        {
          evidence: [
            {
              source: "prometheus:payment_success_rate",
              observedAt: "2026-07-18T00:01:00.000Z",
            },
          ],
        },
        checkedAt,
      ),
    ).toEqual({ ok: true, checkedAt, issues: [] });
  });

  it("rejects a missing required source", () => {
    expect(
      evaluateIncidentEvidence(
        {
          evidence: [
            {
              source: "supplied_snapshot",
              observedAt: "2026-07-18T00:04:00.000Z",
            },
          ],
        },
        checkedAt,
      ),
    ).toMatchObject({
      ok: false,
      issues: ["required evidence source is missing: prometheus:"],
    });
  });

  it("rejects stale required evidence", () => {
    expect(
      evaluateIncidentEvidence(
        {
          evidence: [
            {
              source: "prometheus:payment_success_rate",
              observedAt: "2026-07-17T23:00:00.000Z",
            },
          ],
        },
        checkedAt,
      ),
    ).toMatchObject({
      ok: false,
      issues: ["required evidence source is stale or invalid: prometheus:"],
    });
  });
});
