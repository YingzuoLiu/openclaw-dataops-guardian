import { describe, expect, it } from "vitest";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  projectIncidentState,
  transitionIncidentState,
  type IncidentState,
} from "./incident-state.js";

const incidentState: IncidentState = {
  schemaVersion: 2,
  alertId: "payment-success-rate-drop",
  stage: "alert_received",
  evidence: [],
  proposedAction: null,
  approvalStatus: "not_requested",
  evidenceValidation: {
    status: "not_checked",
    checkedAt: null,
    issues: [],
  },
  retryCount: 0,
  updatedAt: "2026-07-18T00:00:00.000Z",
};

describe("projectIncidentState", () => {
  it("projects JSON-compatible incident state without changing it", () => {
    const state = {
      schemaVersion: 2,
      alertId: "payment-success-rate-drop",
      stage: "alert_received",
      evidence: [],
      proposedAction: null,
      approvalStatus: "not_requested",
      evidenceValidation: {
        status: "not_checked",
        checkedAt: null,
        issues: [],
      },
      retryCount: 0,
      updatedAt: "2026-07-18T00:00:00.000Z",
    } satisfies PluginJsonValue;

    expect(projectIncidentState(state)).toEqual(state);
  });

  it("keeps an absent state absent", () => {
    expect(projectIncidentState(undefined)).toBeUndefined();
  });
});

describe("transitionIncidentState", () => {
  it("applies a legal transition", () => {
    expect(
      transitionIncidentState(
        incidentState,
        "evidence_collection",
        "2026-07-18T00:01:00.000Z",
      ),
    ).toMatchObject({
      stage: "evidence_collection",
      updatedAt: "2026-07-18T00:01:00.000Z",
    });
  });

  it("returns the same object for an idempotent transition", () => {
    expect(
      transitionIncidentState(
        incidentState,
        "alert_received",
        "2026-07-18T00:01:00.000Z",
      ),
    ).toBe(incidentState);
  });

  it("rejects a stage skip", () => {
    expect(() =>
      transitionIncidentState(
        incidentState,
        "remediation",
        "2026-07-18T00:01:00.000Z",
      ),
    ).toThrow("alert_received -> remediation");
  });
});
