# Alertmanager ingestion boundary

Guardian now accepts untrusted Alertmanager webhook v4 payloads through a
small, deterministic ingestion boundary. This step deliberately stops before
HTTP serving, OpenClaw RPC dispatch, or Kubernetes access.

## Boundary

`canonicalizeAlertmanagerWebhook(payload, receivedAt)` validates the webhook
envelope and each alert independently. A valid alert is reduced to the existing
`AlertDelivery` contract:

```text
Alertmanager webhook v4
  -> envelope validation
  -> per-alert validation and canonical timestamps
  -> deterministic delivery ID
  -> AlertDelivery
```

The bridge, rather than the payload, supplies `receivedAt`. Firing alerts always
produce `endsAt=null`; Alertmanager's provisional firing `endsAt` is not trusted
as a lifecycle transition. Resolved alerts require a valid `endsAt` that does
not precede `startsAt`.

The alert fingerprint and `labels.alertname` are required. This step provides no
fallback identity for missing fingerprints because silently merging alerts is
less safe than rejecting a malformed alert.

The accepted input shape follows the official
[Alertmanager webhook configuration](https://prometheus.io/docs/alerting/latest/configuration/#webhook_config).

The envelope's `truncatedAlerts` value is validated and returned as metadata so
the external bridge can audit whether Alertmanager omitted alerts because of
its `max_alerts` setting. It is not silently discarded.

## Delivery identity

The delivery ID is a SHA-256 digest over a stable serialization of the receiver,
group key, canonical lifecycle fields, labels, annotations, and generator URL.
Object key order and ingress time do not affect it. A repeated Alertmanager
payload therefore reaches the reducer with the same delivery ID, while the
state still records that another delivery was received.

The retained deduplication window remains the schema-v3 limit of 50 unique IDs.
This is bounded replay protection, not an unbounded exactly-once claim.

## Evidence boundary

Webhook labels and annotations participate in delivery identity only. They are
not appended to `IncidentState.evidence`, they do not pass evidence validation,
and a resolved webhook does not mark remediation completed. A later workflow
must still query Prometheus and satisfy the existing evidence policy before it
can propose remediation.

## Persistence plan

`planAlertDeliveryIngestion(current, delivery)` exhaustively converts the alert
reducer's decisions into bridge-owned actions:

| Reducer decision | Planner action |
|---|---|
| `created`, `updated`, `duplicate`, `stale_refire` | persist the returned occurrence |
| `new_occurrence` | create and persist an independent occurrence |
| `deferred_new_occurrence` | durably hold a deterministic checkpoint |
| `orphan_resolved` | ignore and audit; do not create state |
| `rejected` | reject and audit; do not overwrite state |

A deferred checkpoint contains the exact canonical delivery, the occurrence
whose running remediation blocks it, and a deterministic checkpoint ID. The
planner performs no I/O. A future external bridge must durably write this
checkpoint before acknowledging the webhook, then follow the restart
reconciliation replay contract in `docs/incident-state-v3.md`.

## Explicit exclusions

This step does not add:

- an HTTP listener;
- authentication, rate limiting, or request-size enforcement;
- a durable checkpoint database;
- OpenClaw session/RPC routing;
- automatic investigation dispatch;
- Kubernetes reads or writes;
- remediation execution.

Run the unit suite and the deterministic proof with:

```bash
npm run check
npm run alertmanager:ingestion-proof
```
