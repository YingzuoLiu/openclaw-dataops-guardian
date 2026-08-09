# Final safety proof and reproducible demo (Step 5)

Status: **accepted on Linux/WSL on 2026-08-08**. This is the `v0.2.0`
release acceptance contract. `npm run demo` passed end to end with an
allowlisted `ok: true` report after cleanup. It composes the component proofs
from Steps 1-4 and adds bounded live failure and authority cases without
expanding Guardian into a production orchestrator.

## Commands

Run the deterministic checks first:

```bash
npm ci
npm run check
```

Run the no-cost fast demo:

```bash
npm run demo:fast
```

`demo:fast` uses Bash, Node.js, isolated OpenClaw profiles, loopback services,
and a scripted local model. It does not use Docker, Kubernetes, an external
model, or a paid API. It disables discovery of unrelated OpenClaw bundled
extensions and explicitly loads only the proof-owned Guardian and Lobster
copies. This keeps the proof valid when WSL DrvFS presents a checkout's
`node_modules` as world-writable. It aggregates:

The runner also clears inherited `OPENCLAW_CONFIG_PATH`, `OPENCLAW_PROFILE`,
and `OPENCLAW_HOME` overrides before assigning its proof-owned state. A caller's
normal OpenClaw profile therefore cannot override the acceptance boundary or be
mutated by the proof.

| Component | Required result |
|---|---|
| Plugin policy registration | no loader diagnostics and all typed hooks registered |
| Live Agent hook | a real Gateway Agent run observes the bounded finalize revision |
| Alertmanager bridge | authentication, validation, durable checkpoint, restart, and crash-window proof passes |
| Synthetic approval | real Lobster resume approves and the fixture reaches `completed` |
| Synthetic denial | real Lobster resume denies and the fixture remains `blocked` |

Run the full proof on Linux/WSL with a reachable Docker daemon, `kind`,
`kubectl`, Node.js, npm, and network access to pull the pinned kind, nginx, and
Prometheus images:

```bash
npm run demo
```

The full command runs `demo:fast`, creates one uniquely named disposable kind
cluster, and releases its machine-readable JSON proof only after the live
matrix and cleanup assertions pass. It uses no paid API or external model. Both
runners emit phase-only progress, bound component runtime when the standard
Linux `timeout` command is available, and retain the existing bounded
diagnostic-tail behavior on failure.

## End-to-end path

The successful live occurrence follows this path:

```text
authenticated Alertmanager HTTP firing
  -> canonicalization, deduplication, and durable Gateway IncidentState
  -> guardian_query_prometheus
  -> guardian_inspect_metric_snapshot
  -> guardian_propose_remediation
  -> resumable Lobster approval
  -> guardian_rollback_deployment
  -> Gateway restart and read-only Deployment reconciliation
  -> guardian_verify_deployment_recovery
  -> trusted persistence boundary
  -> completed state survives another Gateway restart
```

The webhook creates lifecycle state only. It contributes zero metric evidence;
the three evidence/proposal operations above go through the real Gateway
`tools.invoke` path. Administrator configuration, not Tool input or model text,
owns the Prometheus endpoint and recovery policy, cluster identity, scoped
kubeconfig, and exact namespace/Deployment allowlist.

## Live proof matrix

| Boundary | Fault or action | Required assertion |
|---|---|---|
| HTTP authentication | POST without the bridge bearer token | HTTP `401`; no occurrence state is created |
| Canonical ingress | authenticated firing POST | durable occurrence is `created` |
| Bounded replay | repeat the same firing POST | disposition is `duplicate`; no second occurrence or metric evidence |
| Evidence authority | inspect the just-created incident | webhook evidence count is `0`; query, inspect, and propose use Gateway Tools |
| Approval denial | real Lobster decision is deny | the structured approval gate blocks the Tool; state is `blocked`/`denied`; Deployment generation, PodTemplate digest, and rollback audit tuple are unchanged; mutation count `0` |
| Ambiguous restart | persist a running attempt but dispatch no mutation, then audit after restart | external outcome is `unknown`; state is blocked for manual review; mutation count `0` |
| Target authority | approved attempt targets an unallowlisted namespace/Deployment | the structured allowlist gate blocks the Tool; the allowlisted Deployment mutation fingerprint is unchanged |
| Mutation authority | use the proof ServiceAccount outside its exact Role | other Deployment, other namespace, Secret read, create, and delete requests are all `Forbidden` |
| Authorized rollback | invoke the exact approved key and target | decision is `rolled_back`; mutation dispatch count is exactly `1` |
| Rollback replay | invoke the same rollback immediately and after Gateway restart | both decisions are `duplicate` with `patched=false`; generation, PodTemplate digest, and rollback audit tuple remain unchanged |
| Positive reconciliation | audit the applied rollback after restart | outcome is `confirmed_succeeded`; the same attempt advances to `recovery_check` without redispatch |
| Alert lifecycle | deliver the matching `resolved` webhook | alert lifecycle updates, but no recovery evidence is fabricated and the incident is not `completed` |
| Negative recovery | scale the Deployment to zero | decision is `not_recovered`; Deployment health is false; incident remains incomplete |
| Positive recovery | restore one ready replica and wait for a strictly newer passing Prometheus sample | both Deployment and Prometheus are healthy; decision is `recovered`; state reaches `completed` |
| Completion readback | persist the final dual-recovery decision | the persistence boundary independently reads back the exact completed state before returning |
| Recovery replay | restart the Gateway, then invoke recovery again | the fresh process reads `completed` and the Tool gate blocks the replay |
| Durable completion | read the incident from the restarted Gateway | stored incident still reads `completed` |
| Cleanup | finish or abort the runner | bridge, Gateway, port-forward, kind cluster, run-owned local image tags, kubeconfigs, credentials, and proof-owned temporary files are removed |

This deliberately injects one live recovery fault: scale-to-zero. The proof's
administrator-owned PromQL is
`max(payment_success_rate{service="payments",environment="proof"}) or vector(0)`:
it preserves the recovery Tool's exactly-one-series contract and converts an
absent workload target into a determinate unhealthy value instead of an
indeterminate empty vector. Prometheus HTTP errors, genuinely empty or
multi-series policy results, non-finite values, stale/future samples, invalid
timestamps, inconsistent aggregate decisions, and persistence binding failures
remain deterministic unit-test cases under `npm run check`. They do not each
justify another live cluster fault.

## Report contract

On success, both demos keep component stdout and raw logs inside proof-owned
temporary directories. If a component fails, the runner copies only its last
120 local log lines to stderr before deleting the directory, and emits no
success report. `scripts/final-proof-report.mjs` constructs the released JSON
from an explicit field allowlist and validates the result recursively.

The full report contains only:

- schema/proof identifiers, overall `ok`, and zero API cost;
- boolean environment properties;
- ingress dispositions and evidence ownership;
- approval, restart-reconciliation, authorization, mutation, recovery, replay,
  and cleanup decisions or counts;
- the fixed proof metric value and administrator threshold.

It cannot contain token, secret, password, credential, kubeconfig or absolute
path, PodTemplate, raw webhook/evidence payload, prompt, transcript, or
container environment content. The final report is withheld if any matrix,
sanitization, or explicit cleanup assertion fails.

## Cleanup and isolation

The full runner generates a random cluster suffix and checks distinct loopback
ports before use. It pulls proof sources by immutable SHA-256 digest, gives the
selected platform images run-owned local tags, imports and verifies those tags
inside kind, and sets `imagePullPolicy: Never` so Pods cannot silently bypass
the host-side import. It stages the plugin beneath a temporary directory,
creates a short-lived Kubernetes ServiceAccount token, and writes both admin
and scoped kubeconfigs only under that directory.

The exit trap stops the standalone bridge, Gateway, and Prometheus
port-forward, deletes the exact generated kind cluster and run-owned image
tags, and deletes the proof directory on success or failure. On the successful
path, the runner also verifies the cluster, local tags, and kubeconfig files are
gone before allowing the final JSON report to be emitted.

## Scope and residual risks

This proof establishes a single-process, single-writer, single-cluster
prototype boundary. It does not establish production readiness, high
availability, multi-bridge or multi-cluster coordination, Gateway
compare-and-swap semantics, automatic cancellation, managed-Prometheus
authentication, or safe operation against a production cluster. See
[SECURITY.md](../SECURITY.md) and the [operator guide](operator-guide.md).
