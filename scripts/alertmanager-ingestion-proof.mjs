import assert from "node:assert/strict";

import {
  canonicalizeAlertmanagerWebhook,
  planAlertDeliveryIngestion,
} from "../dist/index.js";
import { beginRemediationAttempt } from "../dist/state/incident-workflow.js";

const startsAt = "2026-08-01T00:00:00.000Z";
const firstReceivedAt = "2026-08-01T00:01:00.000Z";

function payload({
  status = "firing",
  occurrenceStartsAt = startsAt,
  endsAt = "2026-08-01T00:05:00.000Z",
} = {}) {
  return {
    version: "4",
    groupKey: '{}:{alertname="PaymentSuccessRateLow"}',
    truncatedAlerts: 0,
    status,
    receiver: "guardian",
    groupLabels: { alertname: "PaymentSuccessRateLow" },
    commonLabels: { alertname: "PaymentSuccessRateLow" },
    commonAnnotations: {},
    externalURL: "http://alertmanager.invalid",
    alerts: [
      {
        status,
        labels: {
          alertname: "PaymentSuccessRateLow",
          namespace: "guardian-demo",
          deployment: "payments",
        },
        annotations: {
          summary: "Payments are unhealthy.",
        },
        startsAt: occurrenceStartsAt,
        endsAt,
        generatorURL: "http://prometheus.invalid/graph",
        fingerprint: "fingerprint-1",
      },
    ],
  };
}

function deliveryFrom(webhook, receivedAt) {
  const canonical = canonicalizeAlertmanagerWebhook(webhook, receivedAt);
  assert.equal(canonical.ok, true);
  assert.equal(canonical.metadata.truncatedAlerts, 0);
  assert.equal(canonical.acceptedAlerts.length, 1);
  assert.equal(canonical.rejectedAlerts.length, 0);
  return canonical.acceptedAlerts[0].delivery;
}

const firingDelivery = deliveryFrom(payload(), firstReceivedAt);
assert.equal(firingDelivery.endsAt, null);

const created = planAlertDeliveryIngestion(undefined, firingDelivery);
assert.equal(created.action, "persist_occurrence");
assert.equal(created.decision, "created");
assert.deepEqual(created.state.evidence, []);
assert.equal(created.state.evidenceValidation.status, "not_checked");

const duplicate = planAlertDeliveryIngestion(created.state, {
  ...firingDelivery,
  receivedAt: "2026-08-01T00:02:00.000Z",
});
assert.equal(duplicate.action, "persist_occurrence");
assert.equal(duplicate.decision, "duplicate");
assert.equal(duplicate.state.nonDuplicateDeliveryCount, 1);

const resolvedDelivery = deliveryFrom(
  payload({
    status: "resolved",
    endsAt: "2026-08-01T00:03:00.000Z",
  }),
  "2026-08-01T00:03:30.000Z",
);
const resolved = planAlertDeliveryIngestion(
  duplicate.state,
  resolvedDelivery,
);
assert.equal(resolved.action, "persist_occurrence");
assert.equal(resolved.decision, "updated");
assert.equal(resolved.state.alertStatus, "resolved");
assert.equal(resolved.state.stage, "alert_received");
assert.deepEqual(resolved.state.evidence, []);

const approved = {
  ...created.state,
  stage: "remediation",
  approvalStatus: "approved",
  proposedAction: "rollback_deployment",
};
const running = beginRemediationAttempt(approved, {
  idempotencyKey: "mutation-key-1",
  target: { namespace: "guardian-demo", deployment: "payments" },
  startedAt: firstReceivedAt,
});
assert.equal(running.decision, "started");

const laterDelivery = deliveryFrom(
  payload({ occurrenceStartsAt: "2026-08-01T01:00:00.000Z" }),
  "2026-08-01T01:01:00.000Z",
);
const held = planAlertDeliveryIngestion(running.state, laterDelivery);
assert.equal(held.action, "hold_deferred_delivery");
assert.equal(held.currentState, running.state);
assert.equal(held.checkpoint.delivery.deliveryId, laterDelivery.deliveryId);
assert.equal(running.state.remediationAttempts[0].status, "running");

console.log(
  JSON.stringify(
    {
      acceptedAlertCount: 1,
      truncatedAlertCount: 0,
      initialDecision: created.decision,
      duplicateDecision: duplicate.decision,
      resolvedDecision: resolved.decision,
      resolvedIncidentStage: resolved.state.stage,
      alertmanagerEvidenceCount: resolved.state.evidence.length,
      deferredAction: held.action,
      deferredCheckpointId: held.checkpoint.checkpointId,
      remediationAttemptStatus: running.state.remediationAttempts[0].status,
      mutationDispatchCount: 0,
    },
    null,
    2,
  ),
);
