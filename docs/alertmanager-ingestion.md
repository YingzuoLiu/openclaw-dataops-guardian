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

### What is validated vs. merely read

Strictly validated, with rejection on failure: envelope `version`, `status`,
`groupKey`, `receiver`, `truncatedAlerts`, and `alerts` (non-empty array); per
alert `status`, `labels` (must be a string map containing `alertname`),
`annotations` (string map), `generatorURL` (string), `fingerprint`
(non-empty string), `startsAt` (valid timestamp, not after `receivedAt`), and
for `resolved` alerts `endsAt` (valid timestamp, not before `startsAt`).

Read but not validated and not used anywhere downstream: the envelope's
`groupLabels`, `commonLabels`, `commonAnnotations`, and `externalURL`. They
are accepted as part of the official webhook shape but Guardian does not
inspect, canonicalize, or expose them. A malformed value in any of these
fields does not cause rejection. Do not rely on them being checked.

## Delivery identity

The delivery ID is a SHA-256 digest over a stable serialization of exactly
four fields: `fingerprint`, `alertStatus`, `startsAt`, and the canonical
`endsAt` (always `null` for firing, a validated fixed timestamp for
resolved). Object key order does not affect it.

Labels, annotations, and `generatorURL` are deliberately **excluded** from
identity. Alertmanager re-sends a still-firing alert on every
`repeat_interval`, and real templates commonly render live values into
annotations (a current metric reading, an elapsed duration) or into
`generatorURL` query parameters — values that change on every re-send even
though it is, semantically, the same lifecycle event. Hashing those fields
would make every periodic re-send look like a distinct delivery and defeat
bounded deduplication. `fingerprint` is Alertmanager's own hash of the
alert's label set, so label identity is already captured without
re-hashing labels here.

This means:

- The same firing occurrence keeps the same delivery ID across repeat
  sends, even when its annotations or `generatorURL` change.
- A `resolved` delivery for an occurrence never collides with that
  occurrence's `firing` delivery — `alertStatus`/`endsAt` differ, so the
  reducer always sees it as a distinct lifecycle transition, not a
  duplicate.
- Two occurrences that share a `fingerprint` but have different `startsAt`
  never collide.

The retained deduplication window remains the schema-v3 limit of 50 unique IDs.
This is bounded replay protection, not an unbounded exactly-once claim.

## Evidence boundary

Webhook labels and annotations are validated (an `alertname` must be present)
but do not participate in delivery identity and are never appended to
`IncidentState.evidence`. They do not pass evidence validation, and a
resolved webhook does not mark remediation completed. A later workflow must
still query Prometheus and satisfy the existing evidence policy before it can
propose remediation.

## Time invariant: `updatedAt` never regresses

`reduceAlertDelivery` treats an incident's `updatedAt` as its logical clock:
every other invariant checked by `readIncidentStateV3` (remediation attempt
timestamps, `lastReceivedAt <= updatedAt`, ...) is expressed relative to it.
A delivery's `receivedAt` is only required to be non-decreasing against the
*previous delivery's* `receivedAt` (`lastReceivedAt`) — not against work the
incident did meanwhile through non-ingestion paths (evidence collection,
approval, a remediation attempt starting). A late-but-otherwise-valid
redelivery — an Alertmanager retry, a duplicate from an HA replica, a
delayed queue entry — can carry a `receivedAt` older than the incident's
current `updatedAt`.

`duplicate`, `updated`, and `stale_refire` therefore compute the next
`updatedAt` as `max(state.updatedAt, delivery.receivedAt)`, while
`lastReceivedAt` is still set to `delivery.receivedAt` unconditionally so it
keeps tracking delivery-ingestion order for the `received_at_regression`
check. This keeps every reducer-produced state passing `readIncidentStateV3`
regardless of how delayed a still-valid delivery is.

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

An HTTP receiver and durable checkpoint/route persistence are now
implemented on top of this boundary, unchanged, by the external bridge in
[`docs/alertmanager-http-bridge.md`](alertmanager-http-bridge.md).
Investigation dispatch, Kubernetes access, and remediation execution remain
out of scope there too.

## Residual risks

These are known gaps in this milestone's design, not implementation bugs.
They are accepted for now because the excluded work above (HTTP receiver,
durable checkpoint storage, remediation cancellation) is what would be
needed to close them. Anyone building the external bridge on top of this
boundary should read this section before assuming stronger guarantees than
what is actually implemented.

- **Orphan-resolved deliveries have no durable replay channel.** If a
  `resolved` delivery is processed before its matching `firing` delivery —
  plausible with concurrent Alertmanager HA replicas, retry backoff, or a
  bridge without strict per-fingerprint ordering — `reduceAlertDelivery`
  returns `orphan_resolved` and the planner's action is "ignore and audit;
  do not create state." Unlike `deferred_new_occurrence`, there is no
  checkpoint for `orphan_resolved`: once the `firing` delivery eventually
  arrives, the incident is created/continued with no memory that a
  resolution was ever observed for it. The only recovery path today is a
  human noticing the audit log.
- **`truncatedAlerts` is an audit signal only, with no automatic
  re-fetch.** Alertmanager does not resend alerts it dropped because of its
  `max_alerts` setting. If the dropped alert was a resolution, the
  corresponding occurrence stays "firing" in Guardian's state indefinitely
  unless a human sees the `truncatedAlerts` count in the audit trail and
  manually intervenes (e.g. by widening `max_alerts` or re-querying
  Alertmanager out of band). This boundary does not attempt to detect or
  compensate for truncation on its own.
- **A `resolved` delivery does not cancel or otherwise affect a running
  remediation attempt.** By design (see "Evidence boundary" above) a
  matching `resolved` delivery updates `alertStatus`/`endsAt` but leaves
  `stage` and `remediationAttempts` untouched, so it cannot mark an
  incident completed out from under an in-flight mutation. But there is
  also no feedback path in the other direction: nothing tells a running
  remediation attempt that Alertmanager now considers the underlying alert
  resolved. `alertStatus: "resolved"` and a `running` remediation attempt
  can coexist indefinitely — a valid state per schema, but one a bridge or
  operator dashboard should be prepared to show clearly, since remediation
  cancellation is explicitly out of scope for this milestone.
- **Deferred-delivery checkpoints are not durable yet in this boundary
  itself.** `planAlertDeliveryIngestion` computes a deterministic
  `DeferredAlertDeliveryCheckpoint` for `deferred_new_occurrence`, but
  performs no I/O — that remains true here, by design (see "Persistence
  plan" above). The external bridge in
  [`docs/alertmanager-http-bridge.md`](alertmanager-http-bridge.md) is now
  the concrete implementation that durably writes the checkpoint before
  acknowledging the webhook, per the restart reconciliation replay contract
  in `docs/incident-state-v3.md`. A bridge that skipped that write would
  still be able to lose a deferred delivery on crash; the shipped bridge
  does not skip it (see its crash-window analysis).
- **`receivedAt` correctness depends on the bridge's clock, and
  transitively on Alertmanager's.** `canonicalizeAlertmanagerWebhook`
  trusts the `receivedAt` value the bridge passes in — it is not derived
  from anything in the untrusted payload — but still rejects an alert whose
  `startsAt` is after that `receivedAt` (`received_before_start`). Under
  clock skew between the bridge and Alertmanager, or a bridge that stamps
  `receivedAt` well after actual HTTP receipt (e.g. due to queuing), this
  can cause legitimate alerts to be fail-closed rejected rather than
  accepted. This is a safe failure mode (no bad state is written) but can
  be operationally confusing; a future bridge should monitor
  `received_before_start` rejection rates as a clock-health signal.

Run the unit suite and the deterministic proof with:

```bash
npm run check
npm run alertmanager:ingestion-proof
```
