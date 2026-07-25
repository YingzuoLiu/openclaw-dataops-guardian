# IncidentState schema v3

Schema v3 adds alert occurrence identity, bounded webhook delivery
deduplication, and durable remediation-attempt history. It is a state-layer
change only: this step does not add an Alertmanager receiver, Kubernetes client,
or real rollback.

## Runtime boundary

All session, RPC, and alert-reducer entry points decode persisted values with
`readIncidentStateV3(value)`. The result distinguishes:

- `missing_state`;
- `unsupported_schema`;
- `invalid_state`.

Internal workflow functions accept an already decoded `IncidentState`. Schema
v2 remains readable through the session extension projection, but v3 mutators
reject it explicitly. `projectIncidentState()` remains a pass-through so the
existing arbitrary-JSON session compatibility proof is unchanged.

## Occurrence identity

An occurrence is identified by:

```text
sha256("incident-occurrence-v1\0" + fingerprint + "\0" + startsAt)
```

The alert reducer accepts a non-empty opaque `deliveryId` from its caller. It
does not parse Alertmanager payloads or define payload canonicalization.
`receivedAt` is the receiver or bridge's ingress time. It must not be copied
from an Alertmanager payload timestamp.

The reducer reports one of:

```text
created
updated
duplicate
new_occurrence
orphan_resolved
stale_refire
rejected
```

A resolved delivery updates lifecycle state but does not mean remediation is
completed. A firing delivery for an already resolved occurrence is recorded as
`stale_refire` without reopening the occurrence.

For the same fingerprint with a different `startsAt`, a firing delivery returns
`new_occurrence`. The reducer does not overwrite or archive the current
occurrence. Its returned `state` is the unchanged state that remains safe to
persist in the current session. The reason is `previous_attempt_running` when
that state has a running remediation attempt, otherwise
`route_to_new_occurrence`.

The future Alertmanager bridge must route that delivery to an independent
occurrence/session and then call `reduceAlertDelivery(undefined, delivery)` to
create its v3 state. Step 1 deliberately does not implement that bridge.

`alertId` may change between occurrences; this is intentional because
fingerprint and `startsAt` define occurrence routing. Within one occurrence,
`alertId` must remain unchanged.

## Delivery window

The state records:

```text
deliveryCount
nonDuplicateDeliveryCount
recentDeliveryIds
```

`deliveryCount` includes retained-window duplicates.
`nonDuplicateDeliveryCount` counts deliveries treated as non-duplicates at the
time they arrive. Only the most recent 50 unique IDs are retained. Once an ID is
evicted, replaying it is treated as a new delivery and increments both counters.
The deduplication guarantee therefore covers only the retained window, not the
full lifetime of an occurrence.

Duplicate delivery still updates `deliveryCount`, `lastReceivedAt`, and
`updatedAt`. It does not append evidence, change approval state, or restart a
workflow.

## Remediation attempt history

Each attempt stores:

```ts
type RemediationTarget = {
  [key: string]: PluginJsonValue;
};

type RemediationAttempt = {
  idempotencyKey: string;
  target: RemediationTarget;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
};
```

The key and target are supplied by the deterministic caller. Guardian does not
compute a Kubernetes-specific key in this step.

The first unseen key creates a running attempt. A repeated key with the same
target is a duplicate; a repeated key with a different target is an
idempotency conflict. A different key cannot start while another attempt is
running. Results must match the current running key.

At most `MAX_REMEDIATION_RETRIES + 1` attempts are retained. The attempt array
length is the only remediation budget. Both execution failure and recovery
failure return to `remediation` while capacity remains; otherwise the incident
becomes `blocked`. Attempt history is never pruned.

## Validator invariants

The runtime decoder verifies occurrence identity, timestamp ordering, delivery
counters and retained IDs, attempt-key uniqueness, the single-running-attempt
rule, result/error consistency, the attempt cap, and finite JSON-compatible
target values.

Run the unit and persistence checks with:

```bash
npm run check
npm run state:v3:restart-proof
```
