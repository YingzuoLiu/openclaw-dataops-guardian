# Kubernetes Deployment rollback (Step 3)

Step 3 upgrades the Day 0 spike's fixed annotation patch into a real,
allowlisted Kubernetes Deployment PodTemplate rollback inside the main
`dataops-guardian` plugin, closed on both sides by durable `IncidentState`
remediation attempts and Deployment audit annotations.

This document covers the `guardian_rollback_deployment` tool, its security
boundaries, and how to run the real kind proof. It does not cover Prometheus
recovery verification or `completed` incidents -- that is Step 4.

## What a "rollback" means here

A rollback is not decrementing a revision number. It is:

1. read the allowlisted Deployment;
2. filter its controller-owned ReplicaSets by the Deployment's UID;
3. find the one ReplicaSet matching the caller's requested historical
   revision;
4. read that ReplicaSet's PodTemplate and strip the controller-injected
   `pod-template-hash` label;
5. verify the live Deployment's current UID, revision, and PodTemplate
   digest match what the caller claims it is rolling back *from*, and that
   the historical ReplicaSet's PodTemplate digest matches what the caller
   claims it is rolling back *to*;
6. patch the Deployment's `spec.template` to the historical PodTemplate and
   its audit annotations in one atomic JSON Patch, guarded by `test`
   operations on `metadata.uid` and `metadata.resourceVersion`.

Kubernetes then normally records this as a *new* revision (e.g. revision 3,
if rolling back from 2 to 1), whose PodTemplate is identical to revision 1.
Success is judged by "the live PodTemplate now equals the target historical
template," not by "the revision counter went back down."

## Strict rollback target

`guardian_rollback_deployment` does not accept a kubeconfig, API server,
arbitrary JSON patch, label selector, shell command, or `kubectl` argument
from the model. It accepts exactly:

```jsonc
{
  "idempotencyKey": "guardian:k8s-rollback:v1:<occurrenceId>:<deploymentUid>:<fromRevision>:<toRevision>:attempt-1",
  "target": {
    "type": "kubernetes_deployment_rollback_v1",
    "clusterId": "guardian-step3-kind",
    "namespace": "guardian-step3",
    "deployment": "payments-step3",
    "deploymentUid": "...",
    "fromRevision": 2,
    "toRevision": 1,
    "fromTemplateSha256": "...",
    "toTemplateSha256": "..."
  }
}
```

`target` is a `RemediationTarget` (the existing generic
`{[key: string]: PluginJsonValue}` contract) decoded by
`decodeKubernetesDeploymentRollbackTarget` in
[`src/kubernetes/deployment-rollback.ts`](../src/kubernetes/deployment-rollback.ts).
The decoder requires the exact key set above -- extra keys, missing keys, an
unrecognized `type`, an invalid namespace/deployment name, `fromRevision ===
toRevision`, or a template digest that is not 64 lowercase hex characters all
fail closed. `IncidentState` and `RemediationTarget` are unchanged; this is a
new target shape recognized only by this tool and its reconciler, not a
schema migration.

## Approval and idempotency binding (`before_tool_call`)

Before `guardian_rollback_deployment` ever reaches Kubernetes,
[`src/hooks/rollback-deployment-gate.ts`](../src/hooks/rollback-deployment-gate.ts)
requires, in order:

1. a decodable `IncidentState` v3 is attached to the session;
2. `approvalStatus === "approved"`;
3. `stage === "remediation"` (the `blocked` manual-review state left behind
   by restart reconciliation does **not** re-authorize a call -- see below);
4. exactly one `running` remediation attempt;
5. the call's `idempotencyKey` equals that attempt's `idempotencyKey`;
6. the call's `target` deep-equals that attempt's persisted `target`;
7. the target decodes as a Kubernetes rollback target whose `clusterId`
   matches the administrator configuration;
8. the target's `namespace`/`deployment` pair is in the administrator
   allowlist.

The tool can only ever replay a state transition that was already durably
persisted by `beginRemediationAttempt` -- it cannot originate one. The
existing three-attempt budget and generic `RemediationTarget` contract are
unchanged.

## Double-sided audit and idempotency

Nothing new is persisted outside `IncidentState` and the Deployment itself.
Every rollback writes four annotations in the *same* JSON Patch as the
PodTemplate change:

- `guardian.openclaw.dev/rollback-key-sha256` -- SHA-256 of the idempotency
  key (never the raw key);
- `guardian.openclaw.dev/rollback-from-revision`
- `guardian.openclaw.dev/rollback-to-revision`
- `guardian.openclaw.dev/rollback-template-sha256`

On a call whose idempotency key matches the Deployment's currently-recorded
rollback key hash exactly (a replay of the *same* attempt):

| Recorded outcome (from/to revision + template digest) vs. request | Live template | Decision |
|---|---|---|
| matches | matches | `duplicate` (no second patch) |
| matches | diverged | `indeterminate` (fail closed, do not overwrite) |
| disagrees with request | -- | `key_conflict` (fail closed) |

A call whose key hash is *absent* (never rolled back) or *different* from
what is recorded (a later incident occurrence rolling the same Deployment
back again, e.g. after it was redeployed and drifted since the first
rollback) is **not** automatically a conflict: it re-validates the
Deployment's live UID, revision, and PodTemplate digest against the new
target's `fromRevision`/`fromTemplateSha256` exactly like a first-ever
rollback. If that live state doesn't match, it fails closed as
`stale_target`; if it does, the rollback proceeds and the JSON Patch
atomically *overwrites* the previous key's four audit annotations with the
new key's. This never bypasses the persisted running-attempt gate in
`before_tool_call` -- reaching this code at all still required an approved
incident with exactly one running attempt whose key and target exactly
match the call.

No token, certificate, kubeconfig, PodTemplate content, or container
environment variable is ever logged or returned by the tool -- only digests,
revisions, UIDs, and decisions.

## Restart reconciliation

[`KubernetesDeploymentRollbackReconciler`](../src/kubernetes/deployment-rollback-reconciler.ts)
implements the existing `ExternalRemediationReconciler` interface
(unchanged from Step 2). On Gateway restart, for a still-`running` attempt
it does a **read-only** check: live Deployment UID, all four audit
annotations (including `rollback-from-revision`, so a Deployment that has
since been rolled back again under a different key does not falsely confirm
an older attempt), and PodTemplate digest must all agree with the persisted
attempt for it to return `confirmed_succeeded`. Anything else -- an
unreadable Deployment, a recreated UID, a partial or drifted audit trail --
returns `unknown`, which
`reconcileIncidentOnRestart` turns into `blocked`/manual review. This
reconciler never returns `confirmed_failed` (a clean negative read cannot
distinguish "never dispatched" from "someone since reset it") and it never
re-dispatches a rollback.

A real reconciliation settles the attempt to `succeeded` and advances the
incident to `stage: "recovery_check"`. Step 3 stops there. Advancing to
`completed` requires the Prometheus recovery check added in Step 4.

## Security boundaries

| Boundary | Step 3 behavior |
|---|---|
| Cluster identity | `clusterId` and `kubeconfigPath` are administrator plugin config only; the kubeconfig's `current-context` must equal `clusterId` or the client factory refuses to build |
| Target scope | exact `namespace`/`deployment` pairs in an administrator allowlist, checked before any Kubernetes API call |
| Write RBAC | `get`, `patch` on the one allowlisted Deployment only |
| ReplicaSet RBAC | `get`, `list` on `replicasets.apps` in the namespace; the code then filters by owner UID in application logic |
| Forbidden | no `create`/`delete`/`update`, no Pods/Secrets/Jobs, no cross-namespace or cluster-scoped access |
| Mutation shape | only an owner-owned historical ReplicaSet's PodTemplate can replace the current one; no arbitrary JSON patch from the model |
| Concurrency | `resourceVersion`/`uid` mismatches fail the JSON Patch atomically; Step 3 does not retry |
| Approval | mutation requires `approved` + a durable running attempt matching key and target exactly |
| Ambiguous results | network/timeout errors are re-thrown, never turned into a `failed` decision; the attempt stays `running` for the restart reconciler |
| Concurrency model | still the single-process, single-writer model from Step 2b; the Gateway session patch has no compare-and-swap. Step 3 does not widen this promise |

### Residual risk: namespace-wide ReplicaSet read

To find a dynamically-named historical ReplicaSet, the ServiceAccount must
be able to `list replicasets.apps` across the whole namespace -- Kubernetes
RBAC cannot scope a `list` by an owner's UID. Write access stays scoped to
exactly one Deployment; the ReplicaSet read is narrowed to "owned by this
Deployment's UID" only in application code, not by RBAC. An operator who
needs a tighter RBAC boundary must put the Deployment in a namespace with no
other sensitive ReplicaSets.

## Running the real kind proof

```bash
npm run kubernetes:kind-rollback-proof
```

Requires Docker, `kind`, and `kubectl` on `PATH` with a working container
runtime -- the same environment the Day 0 spike used (Windows 11 + WSL2 +
Docker Desktop). It does not run in network-restricted sandboxes that cannot
pull the kind node image.

The proof:

1. creates an isolated `guardian-step3-kind` cluster and `guardian-step3`
   namespace;
2. creates `payments-step3` at revision 1 (`pause:3.9`), then updates it to
   revision 2 (`pause:3.10`), confirming both controller-owned ReplicaSets
   exist;
3. creates a scoped ServiceAccount, Role/RoleBinding (`get,patch` on the one
   Deployment; `get,list` on namespace ReplicaSets), and a short-lived token;
4. starts a real OpenClaw Gateway with the main plugin linked, and persists
   an approved `IncidentState` with a running remediation attempt whose
   target is discovered from the live cluster (not fabricated);
5. calls `guardian_rollback_deployment` through the real Gateway
   `tools.invoke` path and confirms Kubernetes assigns a *new* revision
   beyond `fromRevision` (never asserted equal to the historical
   `toRevision` number), whose live PodTemplate digest, Deployment UID, and
   all four audit annotations match the target;
6. replays the identical call and confirms `duplicate`, with the Deployment
   `resourceVersion`/`generation` unchanged (mutation count stays 1);
7. confirms a target outside the allowlist is blocked;
8. stops the Gateway without ever marking the attempt finished (the crash
   window), restarts it, and confirms the read-only reconciler settles the
   attempt to `succeeded` and advances the incident to `recovery_check`;
9. confirms a further call is blocked once the attempt is no longer running;
10. forward-redeploys the Deployment (a PodTemplate content change) so it
    drifts away from the first rollback's result, then starts a second,
    later incident occurrence and rolls the same Deployment back again
    under a *different* idempotency key -- confirming a legitimate new
    occurrence is accepted (not permanently `key_conflict`) and atomically
    overwrites the first attempt's audit annotations with the second's;
11. confirms the scoped credential cannot patch a second Deployment in the
    same namespace, list another namespace, read Secrets, or create/delete
    resources;
12. deletes the cluster and all temporary credentials/kubeconfig/state.

The script prints a final summary object to stdout; it contains no token,
certificate, kubeconfig, PodTemplate content, or local absolute path.
