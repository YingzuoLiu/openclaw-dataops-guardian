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
deferred_new_occurrence
orphan_resolved
stale_refire
rejected
```

`AlertDeliveryResult` is a discriminated union, so each decision carries only
the fields that are meaningful for it. `orphan_resolved` and `rejected` carry a
required, typed `reason`; the other decisions carry none.

The meaning of the returned `state` depends on the decision. For `created`,
`updated`, `duplicate`, and `stale_refire` it is the state to persist for the
current occurrence. For `new_occurrence` and `deferred_new_occurrence` it is the
unchanged current occurrence, which must not be overwritten with the new
delivery. For `orphan_resolved` and `rejected` it is the unchanged current
occurrence when one exists, otherwise `undefined`, and nothing should be
persisted.

A resolved delivery updates lifecycle state but does not mean remediation is
completed. A firing delivery for an already resolved occurrence is recorded as
`stale_refire` without reopening the occurrence.

For the same fingerprint with a different `startsAt`, the reducer does not
overwrite or archive the current occurrence. Its returned `state` is the
unchanged state that remains safe to persist in the current session.

When the current occurrence has no in-flight remediation, the reducer returns
`new_occurrence`. The caller routes the delivery to an independent
occurrence/session and calls `reduceAlertDelivery(undefined, delivery)` to
create its v3 state.

When the current occurrence has a remediation attempt that has started and not
yet finished, the reducer returns `deferred_new_occurrence`. The caller must not
create the new occurrence yet. It must first settle the running attempt through
`finishRemediationAttempt` during uninterrupted execution, or through restart
reconciliation after a process interruption, and only then process the held
delivery again. An outcome that cannot be established must not be recorded as
`failed`. Creating the new occurrence while the attempt is running would leave
the in-flight action untracked and would allow a second remediation to start
under a different idempotency key.

The delivery is not counted in any state until it is routed:
`new_occurrence` and `deferred_new_occurrence` leave the current occurrence's
counters untouched and create nothing. A caller that receives
`deferred_new_occurrence` is therefore the only record of the held delivery and
must retain it until it can be routed.

Step 2 callers must handle the decision through an exhaustive switch with a
`never` assertion. This makes an omitted `deferred_new_occurrence` branch a
compile-time failure instead of silently applying `new_occurrence` behavior.

The follow-on Alertmanager ingestion boundary now implements the exhaustive
decision planner and deterministic held-delivery checkpoint shape. Durable
checkpoint storage, HTTP acknowledgement, and session/RPC routing remain the
responsibility of a future external bridge. See `docs/alertmanager-ingestion.md`.

### Restart reconciliation for running attempts

Schema v3 does not attach a lease or timeout to a `running` remediation attempt.
If the process terminates after `beginRemediationAttempt` persists the attempt
but before `finishRemediationAttempt` records its result, that attempt remains
valid and `running` after restart. It continues to reject a different attempt
key and causes later occurrences to return `deferred_new_occurrence`.

`ExternalRemediationReconciler` is the boundary between the state machine and a
future target-specific audit implementation. It receives the persisted attempt's
existing `idempotencyKey`, `target`, and `startedAt`. It can return only:

```text
confirmed_succeeded
confirmed_failed
unknown
```

The reconciliation coordinator never dispatches a mutation. It only inspects
and settles the already persisted attempt. A thrown reconciler error leaves the
persisted state untouched. A malformed reconciler result is normalized to
`unknown` and therefore cannot unlock a mutation.

The precise startup state machine is:

| Persisted state / external result | Attempt after reconciliation | Incident stage | Deferred delivery | New mutation allowed |
|---|---|---|---|---|
| no running attempt | unchanged | unchanged | replay through the reducer, if present | governed by the ordinary workflow |
| running + `confirmed_succeeded` | same key/target → `succeeded` | `recovery_check` | replay through the reducer | no; recovery must run first |
| running + `confirmed_failed`, budget remains | same key/target → `failed` | `remediation` | replay through the reducer | yes, because failure/non-execution is confirmed |
| running + `confirmed_failed`, budget exhausted | same key/target → `failed` | `blocked` | replay through the reducer | no |
| running + `unknown` | remains `running` | `blocked` | retained unchanged by the bridge checkpoint | no |

The fail-closed manual-review representation deliberately adds no speculative
schema field. It is the validated combination:

```text
stage = blocked
approvalStatus = approved
exactly one remediation attempt has status = running
```

Reconciliation appends evidence with source
`guardian_restart_reconciliation`. The unfinished attempt continues to make
`beginRemediationAttempt` return `running_attempt_exists`, and the reducer
continues to return `deferred_new_occurrence`. A later startup may inspect the
same key and target again; only a conclusive result can settle it. There is no
lease, timeout, or automatic retry.

The deferred delivery is not added to `IncidentState`. It belongs to a durable,
bridge-owned checkpoint alongside the incident state. On `unknown`, the
coordinator returns the exact delivery as `held`. After a confirmed settlement,
or when startup finds that the attempt was already settled, it calls
`reduceAlertDelivery` again and returns the delivery plus its `replayed` result.
The bridge can then exhaustively route `new_occurrence`; the current occurrence
is never overwritten. Replay is an at-least-once handoff: the bridge must keep
the checkpoint until the deterministic destination occurrence has durably
accepted the delivery, then atomically mark or remove that checkpoint. If the
bridge restarts before that acknowledgement, it replays the same `deliveryId`
to the same occurrence so the existing delivery deduplication handles the
repeat. The coordinator itself never silently consumes the held delivery.

This contract does not implement an Alertmanager receiver, Kubernetes access,
or rollback execution. A future external adapter must provide the target-specific
read/audit operation behind `ExternalRemediationReconciler`.

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
npm run state:restart-reconciliation-proof
```

The restart-reconciliation proof uses two processes and two durable fixtures.
The first process persists a running attempt and held delivery, dispatches one
synthetic external mutation, and is terminated with `SIGKILL` before result
persistence. The second process reads the checkpoint, confirms the effect from
the separate external audit, settles the original key, replays the held
delivery, and asserts that the mutation dispatch count remains one.
