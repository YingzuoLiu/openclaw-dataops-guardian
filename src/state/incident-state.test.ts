import { describe, expect, it } from "vitest";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import {
  createIncidentOccurrenceId,
  projectIncidentState,
  readIncidentStateV3,
  transitionIncidentState,
  type IncidentState,
} from "./incident-state.js";

const startsAt = "2026-07-25T00:00:00.000Z";

function validState(): IncidentState {
  return {
    schemaVersion: 3,
    alertId: "payment-success-rate-drop",
    fingerprint: "alert-fingerprint",
    occurrenceId: createIncidentOccurrenceId("alert-fingerprint", startsAt),
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    lastReceivedAt: startsAt,
    deliveryCount: 1,
    nonDuplicateDeliveryCount: 1,
    recentDeliveryIds: ["delivery-1"],
    stage: "alert_received",
    evidence: [],
    proposedAction: null,
    approvalStatus: "not_requested",
    remediationAttempts: [],
    evidenceValidation: {
      status: "not_checked",
      checkedAt: null,
      issues: [],
    },
    updatedAt: startsAt,
  };
}

describe("projectIncidentState", () => {
  it("keeps arbitrary JSON-compatible state unchanged", () => {
    const legacy = {
      schemaVersion: 2,
      alertId: "legacy-alert",
    } satisfies PluginJsonValue;

    expect(projectIncidentState(legacy)).toBe(legacy);
    expect(projectIncidentState(undefined)).toBeUndefined();
  });
});

describe("readIncidentStateV3", () => {
  it("decodes a valid v3 incident", () => {
    const state = validState();
    expect(readIncidentStateV3(state)).toEqual({ ok: true, state });
  });

  it("distinguishes missing, unsupported, and invalid state", () => {
    expect(readIncidentStateV3(undefined)).toMatchObject({
      ok: false,
      error: "missing_state",
    });
    expect(
      readIncidentStateV3({
        schemaVersion: 2,
        alertId: "legacy",
      }),
    ).toMatchObject({
      ok: false,
      error: "unsupported_schema",
    });
    expect(readIncidentStateV3({ schemaVersion: 3 })).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });

  it("validates occurrence identity, timestamps, and delivery counters", () => {
    const invalidOccurrence = {
      ...validState(),
      occurrenceId: "wrong",
    };
    expect(readIncidentStateV3(invalidOccurrence)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const invalidOrder = {
      ...validState(),
      lastReceivedAt: "2026-07-24T23:59:59.000Z",
    };
    expect(readIncidentStateV3(invalidOrder)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const invalidCounters = {
      ...validState(),
      deliveryCount: 0,
    };
    expect(readIncidentStateV3(invalidCounters)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });

  it("requires recent delivery IDs to be non-empty, unique, and bounded", () => {
    const duplicateIds = {
      ...validState(),
      deliveryCount: 2,
      nonDuplicateDeliveryCount: 2,
      recentDeliveryIds: ["delivery-1", "delivery-1"],
    };
    expect(readIncidentStateV3(duplicateIds)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const tooManyIds = {
      ...validState(),
      deliveryCount: 51,
      nonDuplicateDeliveryCount: 51,
      recentDeliveryIds: Array.from(
        { length: 51 },
        (_, index) => `delivery-${index}`,
      ),
    };
    expect(readIncidentStateV3(tooManyIds)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });

  it("validates bounded, unique remediation attempts and running invariants", () => {
    const runningAttempt = {
      idempotencyKey: "attempt-1",
      target: { kind: "synthetic" },
      status: "running" as const,
      startedAt: startsAt,
      finishedAt: null,
      error: null,
    };
    const invalidRunning = {
      ...validState(),
      remediationAttempts: [runningAttempt],
    };
    expect(readIncidentStateV3(invalidRunning)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const manualReview = {
      ...validState(),
      stage: "blocked" as const,
      approvalStatus: "approved" as const,
      remediationAttempts: [runningAttempt],
    };
    expect(readIncidentStateV3(manualReview)).toEqual({
      ok: true,
      state: manualReview,
    });

    const duplicateKeys = {
      ...validState(),
      remediationAttempts: [
        {
          ...runningAttempt,
          status: "succeeded" as const,
          finishedAt: startsAt,
        },
        {
          ...runningAttempt,
          status: "failed" as const,
          finishedAt: startsAt,
          error: "failed",
        },
      ],
    };
    expect(readIncidentStateV3(duplicateKeys)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const tooManyAttempts = {
      ...validState(),
      remediationAttempts: Array.from({ length: 4 }, (_, index) => ({
        idempotencyKey: `attempt-${index}`,
        target: { kind: "synthetic" },
        status: "succeeded" as const,
        startedAt: startsAt,
        finishedAt: startsAt,
        error: null,
      })),
    };
    expect(readIncidentStateV3(tooManyAttempts)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });

  it("rejects invalid attempt results and non-finite target values", () => {
    const invalidResult = {
      ...validState(),
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          target: { kind: "synthetic" },
          status: "failed" as const,
          startedAt: startsAt,
          finishedAt: startsAt,
          error: "",
        },
      ],
    };
    expect(readIncidentStateV3(invalidResult)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const nonFiniteTarget = {
      ...validState(),
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          target: { value: Number.POSITIVE_INFINITY },
          status: "succeeded" as const,
          startedAt: startsAt,
          finishedAt: startsAt,
          error: null,
        },
      ],
    } as unknown as PluginJsonValue;
    expect(readIncidentStateV3(nonFiniteTarget)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });

    const nonJsonObjectTarget = {
      ...validState(),
      remediationAttempts: [
        {
          idempotencyKey: "attempt-1",
          target: { value: new Date(startsAt) },
          status: "succeeded" as const,
          startedAt: startsAt,
          finishedAt: startsAt,
          error: null,
        },
      ],
    } as unknown as PluginJsonValue;
    expect(readIncidentStateV3(nonJsonObjectTarget)).toMatchObject({
      ok: false,
      error: "invalid_state",
    });
  });
});

describe("transitionIncidentState", () => {
  it("applies legal transitions and rejects stage skips", () => {
    const state = validState();
    expect(
      transitionIncidentState(
        state,
        "evidence_collection",
        "2026-07-25T00:01:00.000Z",
      ),
    ).toMatchObject({
      stage: "evidence_collection",
      updatedAt: "2026-07-25T00:01:00.000Z",
    });
    expect(transitionIncidentState(state, "alert_received", startsAt)).toBe(
      state,
    );
    expect(() =>
      transitionIncidentState(state, "remediation", startsAt),
    ).toThrow("alert_received -> remediation");
  });
});
