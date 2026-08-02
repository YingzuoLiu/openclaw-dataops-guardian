import { describe, expect, it } from "vitest";

import { beginRemediationAttempt } from "../state/incident-workflow.js";
import type { IncidentState } from "../state/incident-state.js";
import {
  canonicalizeAlertmanagerWebhook,
  planAlertDeliveryIngestion,
} from "./ingestion.js";

const startsAt = "2026-08-01T00:00:00.000Z";
const receivedAt = "2026-08-01T00:01:00.000Z";

function webhookAlert(overrides: Record<string, unknown> = {}) {
  return {
    status: "firing",
    labels: {
      alertname: "PaymentSuccessRateLow",
      deployment: "payments",
      namespace: "guardian-demo",
    },
    annotations: {
      description: "Payment success rate is below threshold.",
      summary: "Payments are unhealthy.",
    },
    startsAt,
    endsAt: "2026-08-01T00:05:00.000Z",
    generatorURL: "http://prometheus.example/graph?g0.expr=payment_success_rate",
    fingerprint: "fingerprint-1",
    ...overrides,
  };
}

function webhook(overrides: Record<string, unknown> = {}) {
  return {
    version: "4",
    groupKey: '{}:{alertname="PaymentSuccessRateLow"}',
    truncatedAlerts: 0,
    status: "firing",
    receiver: "guardian",
    groupLabels: { alertname: "PaymentSuccessRateLow" },
    commonLabels: { alertname: "PaymentSuccessRateLow" },
    commonAnnotations: {},
    externalURL: "http://alertmanager.example",
    alerts: [webhookAlert()],
    ...overrides,
  };
}

function canonicalDelivery(
  payload = webhook(),
  ingressTime = receivedAt,
) {
  const result = canonicalizeAlertmanagerWebhook(payload, ingressTime);
  if (!result.ok || !result.acceptedAlerts[0]) {
    throw new Error("fixture webhook was not canonicalized");
  }
  return result.acceptedAlerts[0].delivery;
}

describe("canonicalizeAlertmanagerWebhook", () => {
  it("canonicalizes one standard v4 firing alert without trusting payload endsAt", () => {
    const result = canonicalizeAlertmanagerWebhook(webhook(), receivedAt);

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        version: "4",
        groupStatus: "firing",
        receiver: "guardian",
        truncatedAlerts: 0,
      },
      rejectedAlerts: [],
      acceptedAlerts: [
        {
          index: 0,
          delivery: {
            alertId: "PaymentSuccessRateLow",
            fingerprint: "fingerprint-1",
            alertStatus: "firing",
            startsAt,
            endsAt: null,
            receivedAt,
          },
        },
      ],
    });
    if (!result.ok) {
      throw new Error("webhook was unexpectedly rejected");
    }
    expect(result.acceptedAlerts[0]?.delivery.deliveryId).toMatch(
      /^am-v4:[a-f0-9]{64}$/,
    );
  });

  it("produces stable delivery identity across object key order and ingress time", () => {
    const first = canonicalDelivery();
    const reordered = webhook({
      alerts: [
        webhookAlert({
          labels: {
            namespace: "guardian-demo",
            alertname: "PaymentSuccessRateLow",
            deployment: "payments",
          },
          annotations: {
            summary: "Payments are unhealthy.",
            description: "Payment success rate is below threshold.",
          },
        }),
      ],
    });
    const secondResult = canonicalizeAlertmanagerWebhook(
      reordered,
      "2026-08-01T00:02:00.000Z",
    );
    if (!secondResult.ok || !secondResult.acceptedAlerts[0]) {
      throw new Error("reordered fixture webhook was not canonicalized");
    }

    expect(secondResult.acceptedAlerts[0].delivery.deliveryId).toBe(
      first.deliveryId,
    );
    expect(secondResult.acceptedAlerts[0].delivery.receivedAt).not.toBe(
      first.receivedAt,
    );
  });

  it("accepts valid alerts independently while rejecting malformed alerts", () => {
    const result = canonicalizeAlertmanagerWebhook(
      webhook({
        alerts: [
          webhookAlert(),
          webhookAlert({ fingerprint: "" }),
          webhookAlert({ labels: { namespace: "guardian-demo" } }),
          webhookAlert({ generatorURL: 42 }),
        ],
      }),
      receivedAt,
    );

    expect(result).toMatchObject({
      ok: true,
      acceptedAlerts: [{ index: 0 }],
      rejectedAlerts: [
        { index: 1, reason: "invalid_fingerprint" },
        { index: 2, reason: "missing_alertname" },
        { index: 3, reason: "invalid_generator_url" },
      ],
    });
  });

  it("canonicalizes resolved lifecycle and rejects invalid envelope input", () => {
    const resolved = canonicalizeAlertmanagerWebhook(
      webhook({
        status: "resolved",
        alerts: [
          webhookAlert({
            status: "resolved",
            endsAt: "2026-08-01T00:03:00Z",
          }),
        ],
      }),
      receivedAt,
    );
    expect(resolved).toMatchObject({
      ok: true,
      acceptedAlerts: [
        {
          delivery: {
            alertStatus: "resolved",
            endsAt: "2026-08-01T00:03:00.000Z",
          },
        },
      ],
    });

    expect(
      canonicalizeAlertmanagerWebhook(
        webhook({ version: "3" }),
        receivedAt,
      ),
    ).toEqual({ ok: false, reason: "unsupported_version" });
    expect(canonicalizeAlertmanagerWebhook(webhook(), "not-a-time")).toEqual(
      { ok: false, reason: "invalid_received_at" },
    );
    expect(
      canonicalizeAlertmanagerWebhook(
        webhook({ truncatedAlerts: -1 }),
        receivedAt,
      ),
    ).toEqual({ ok: false, reason: "invalid_truncated_alerts" });
    expect(
      canonicalizeAlertmanagerWebhook(
        webhook({
          alerts: [webhookAlert({ startsAt: "2026-08-01T00:00:00" })],
        }),
        receivedAt,
      ),
    ).toMatchObject({
      ok: true,
      acceptedAlerts: [],
      rejectedAlerts: [{ index: 0, reason: "invalid_starts_at" }],
    });
  });
});

describe("delivery identity stability", () => {
  it("keeps the same delivery ID for the same firing occurrence when only annotations change", () => {
    const first = canonicalDelivery();
    const second = canonicalDelivery(
      webhook({
        alerts: [
          webhookAlert({
            annotations: {
              description: "Payment success rate dropped further.",
              summary: "Payments are now critically unhealthy.",
              currentValue: "12%",
            },
          }),
        ],
      }),
      "2026-08-01T00:05:00.000Z",
    );

    expect(second.deliveryId).toBe(first.deliveryId);
  });

  it("keeps the same delivery ID for the same firing occurrence when generatorURL changes", () => {
    const first = canonicalDelivery();
    const second = canonicalDelivery(
      webhook({
        alerts: [
          webhookAlert({
            generatorURL:
              "http://prometheus.example/graph?g0.expr=payment_success_rate&g0.tab=1&t=1754006700",
          }),
        ],
      }),
      "2026-08-01T00:05:00.000Z",
    );

    expect(second.deliveryId).toBe(first.deliveryId);
  });

  it("keeps the same delivery ID when labels, annotations, and generatorURL all change together", () => {
    const first = canonicalDelivery();
    const second = canonicalDelivery(
      webhook({
        alerts: [
          webhookAlert({
            labels: {
              alertname: "PaymentSuccessRateLow",
              deployment: "payments",
              namespace: "guardian-demo",
              extra_label: "added-on-repeat",
            },
            annotations: { summary: "Different summary entirely." },
            generatorURL: "http://prometheus.example/graph?g0.expr=other",
          }),
        ],
      }),
      "2026-08-01T00:09:00.000Z",
    );

    expect(second.deliveryId).toBe(first.deliveryId);
  });

  it("does not deduplicate a resolved delivery against its own firing delivery", () => {
    const firing = canonicalDelivery();
    const resolved = canonicalDelivery(
      webhook({
        status: "resolved",
        alerts: [
          webhookAlert({
            status: "resolved",
            endsAt: "2026-08-01T00:05:00.000Z",
          }),
        ],
      }),
      "2026-08-01T00:05:30.000Z",
    );

    expect(resolved.deliveryId).not.toBe(firing.deliveryId);
  });

  it("does not deduplicate a new occurrence sharing the same fingerprint but a different startsAt", () => {
    const first = canonicalDelivery();
    const nextOccurrence = canonicalDelivery(
      webhook({
        alerts: [
          webhookAlert({
            startsAt: "2026-08-01T02:00:00.000Z",
          }),
        ],
      }),
      "2026-08-01T02:00:05.000Z",
    );

    expect(nextOccurrence.deliveryId).not.toBe(first.deliveryId);
  });
});

describe("planAlertDeliveryIngestion", () => {
  it("persists firing and resolved lifecycle without treating webhook data as evidence", () => {
    const firing = planAlertDeliveryIngestion(
      undefined,
      canonicalDelivery(),
    );
    expect(firing).toMatchObject({
      action: "persist_occurrence",
      decision: "created",
      state: {
        stage: "alert_received",
        alertStatus: "firing",
        evidence: [],
        evidenceValidation: { status: "not_checked" },
      },
    });
    if (firing.action !== "persist_occurrence") {
      throw new Error("fixture incident was not persisted");
    }

    const resolvedDelivery = canonicalDelivery(
      webhook({
        status: "resolved",
        alerts: [
          webhookAlert({
            status: "resolved",
            endsAt: "2026-08-01T00:03:00.000Z",
          }),
        ],
      }),
    );
    const resolved = planAlertDeliveryIngestion(
      firing.state,
      resolvedDelivery,
    );
    expect(resolved).toMatchObject({
      action: "persist_occurrence",
      decision: "updated",
      state: {
        stage: "alert_received",
        alertStatus: "resolved",
        evidence: [],
        evidenceValidation: { status: "not_checked" },
      },
    });
  });

  it("records repeated webhook delivery as a bounded duplicate", () => {
    const delivery = canonicalDelivery();
    const created = planAlertDeliveryIngestion(undefined, delivery);
    if (created.action !== "persist_occurrence") {
      throw new Error("fixture incident was not persisted");
    }
    const duplicate = planAlertDeliveryIngestion(created.state, {
      ...delivery,
      receivedAt: "2026-08-01T00:02:00.000Z",
    });

    expect(duplicate).toMatchObject({
      action: "persist_occurrence",
      decision: "duplicate",
      state: {
        deliveryCount: 2,
        nonDuplicateDeliveryCount: 1,
        evidence: [],
      },
    });
  });

  it("creates an independent occurrence for a later firing startsAt", () => {
    const created = planAlertDeliveryIngestion(
      undefined,
      canonicalDelivery(),
    );
    if (created.action !== "persist_occurrence") {
      throw new Error("fixture incident was not persisted");
    }
    const next = planAlertDeliveryIngestion(
      created.state,
      canonicalDelivery(
        webhook({
          alerts: [
            webhookAlert({
              startsAt: "2026-08-01T01:00:00.000Z",
              fingerprint: "fingerprint-1",
            }),
          ],
        }),
        "2026-08-01T01:01:00.000Z",
      ),
    );

    expect(next).toMatchObject({
      action: "persist_new_occurrence",
      decision: "new_occurrence",
      previousOccurrenceId: created.occurrenceId,
      state: {
        startsAt: "2026-08-01T01:00:00.000Z",
        deliveryCount: 1,
      },
    });
    if (next.action !== "persist_new_occurrence") {
      throw new Error("new occurrence was not planned");
    }
    expect(next.occurrenceId).not.toBe(next.previousOccurrenceId);
  });

  it("holds a deterministic checkpoint while the previous occurrence has a running mutation", () => {
    const created = planAlertDeliveryIngestion(
      undefined,
      canonicalDelivery(),
    );
    if (created.action !== "persist_occurrence") {
      throw new Error("fixture incident was not persisted");
    }
    const approved: IncidentState = {
      ...created.state,
      stage: "remediation",
      approvalStatus: "approved",
      proposedAction: "rollback_deployment",
    };
    const started = beginRemediationAttempt(approved, {
      idempotencyKey: "mutation-key-1",
      target: { namespace: "guardian-demo", deployment: "payments" },
      startedAt: receivedAt,
    });
    if (started.decision !== "started") {
      throw new Error("fixture remediation attempt was not started");
    }
    const nextDelivery = canonicalDelivery(
      webhook({
        alerts: [
          webhookAlert({
            startsAt: "2026-08-01T01:00:00.000Z",
          }),
        ],
      }),
      "2026-08-01T01:01:00.000Z",
    );

    const first = planAlertDeliveryIngestion(started.state, nextDelivery);
    const replay = planAlertDeliveryIngestion(started.state, nextDelivery);

    expect(first).toMatchObject({
      action: "hold_deferred_delivery",
      decision: "deferred_new_occurrence",
      currentState: {
        occurrenceId: created.occurrenceId,
        remediationAttempts: [{ status: "running" }],
      },
      checkpoint: {
        schemaVersion: 1,
        blockedByOccurrenceId: created.occurrenceId,
        delivery: nextDelivery,
      },
    });
    if (
      first.action !== "hold_deferred_delivery" ||
      replay.action !== "hold_deferred_delivery"
    ) {
      throw new Error("delivery was not held");
    }
    expect(first.checkpoint.checkpointId).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.checkpoint.checkpointId).toBe(
      first.checkpoint.checkpointId,
    );
    expect(first.currentState).toBe(started.state);
  });

  it("ignores a resolved alert with no matching occurrence", () => {
    const resolvedDelivery = canonicalDelivery(
      webhook({
        status: "resolved",
        alerts: [
          webhookAlert({
            status: "resolved",
            endsAt: "2026-08-01T00:03:00.000Z",
          }),
        ],
      }),
    );

    expect(planAlertDeliveryIngestion(undefined, resolvedDelivery)).toEqual({
      action: "ignore_orphan_resolved",
      decision: "orphan_resolved",
      reason: "no_matching_occurrence",
      currentState: undefined,
    });
  });
});
