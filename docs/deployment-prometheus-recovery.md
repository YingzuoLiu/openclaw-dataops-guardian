# Deployment and Prometheus recovery verification (Step 4)

Status: **implemented and proven**. See [Sanitized proof summary](#sanitized-proof-summary-2026-08-08) below.

This is the Step 4 component contract. The
[Step 5 final safety proof](final-safety-proof.md) adds real HTTP ingress plus
denial, ambiguous restart, RBAC/off-target, resolved-webhook, scale-to-zero,
sanitization, and cleanup cases.

Step 4 closes the successful rollback path from `recovery_check` to
`completed`. A successful check requires two independent live observations:

1. the allowlisted Kubernetes Deployment is ready and still carries the exact
   UID, restored PodTemplate digest, and four rollback audit annotations bound
   to the succeeded remediation attempt;
2. a fresh, post-remediation sample from the administrator-configured
   Prometheus query passes the administrator-configured threshold.

Neither an Alertmanager `resolved` delivery nor model-authored prose can mark
the incident recovered.

## Administrator-owned policy

Recovery policy belongs to the exact allowlisted Deployment entry:

```jsonc
{
  "prometheusBaseUrl": "http://127.0.0.1:9090",
  "prometheusTimeoutMs": 5000,
  "kubernetes": {
    "clusterId": "production-cluster-context",
    "kubeconfigPath": "/etc/guardian/scoped-kubeconfig",
    "allowlist": [
      {
        "namespace": "payments",
        "deployment": "payments-api",
        "recovery": {
          "prometheusQuery": "payment_success_rate{service=\"payments\"}",
          "comparator": "gte",
          "threshold": 0.95,
          "maxSampleAgeSeconds": 120
        }
      }
    ]
  }
}
```

The Tool caller supplies only the already-persisted rollback binding:

```jsonc
{
  "idempotencyKey": "<exact succeeded attempt key>",
  "target": { "...": "<exact persisted rollback target>" },
  "notBefore": "<exact succeeded attempt finishedAt>"
}
```

`before_tool_call` rejects any call unless the incident is approved and at
`stage: "recovery_check"`, the key identifies a `succeeded` attempt, the target
deep-equals that attempt's target, and `notBefore` equals its `finishedAt`.
The caller cannot override the endpoint, PromQL, comparison, threshold, sample
age, cluster, kubeconfig, or allowlist.

## Kubernetes recovery conditions

`guardian_verify_deployment_recovery` returns no PodTemplate content,
environment variables, token, certificate, or kubeconfig. It checks:

- live Deployment UID equals the persisted rollback target UID;
- live PodTemplate digest equals `target.toTemplateSha256`;
- rollback key hash, from revision, to revision, and template digest
  annotations match the same attempt;
- desired replicas is positive;
- the controller has observed the current Deployment generation;
- updated and available replicas both equal desired replicas, with zero
  unavailable replicas.

This prevents a deleted/recreated Deployment, a later rollout, a partial audit
trail, or a zero-replica no-op from being reported as recovered.

## Prometheus recovery conditions

The existing read-only instant-query adapter still requires exactly one finite
vector sample. Step 4 additionally requires:

- the sample timestamp is not earlier than the remediation attempt's durable
  `finishedAt`;
- the sample is within `maxSampleAgeSeconds` and no more than 30 seconds in the
  future;
- its value passes the configured `gte` or `lte` threshold.

An HTTP error, ambiguous result, invalid configuration, Kubernetes read error,
or other indeterminate observation throws and leaves the durable incident at
`recovery_check`. A determinate unhealthy result is recorded only through
`persistDeploymentRecoveryVerification`, which rechecks the attempt/result
binding before writing the next `IncidentState`.

The disposable proof configures
`max(payment_success_rate{service="payments",environment="proof"}) or vector(0)`.
That administrator-owned expression still yields exactly one sample when the
workload is absent, so the live scale-to-zero fault is evaluated as unhealthy
rather than becoming an empty-vector transport error.

## Real proof

```bash
npm run recovery:kind-prometheus-proof
```

Prerequisites are Linux/WSL, Docker, `kind`, `kubectl`, and network access to
pull `nginx:1.27.5-alpine` and `prom/prometheus:v2.53.5`.

The proof creates an isolated cluster and:

1. deploys a one-replica nginx workload whose `/metrics` endpoint reports
   `payment_success_rate=1.0`;
2. deploys a real Prometheus server that scrapes that endpoint every second;
3. rolls the workload forward to revision 2, whose metric is `0.7`;
4. reads the degraded value through the real Guardian Prometheus Tool, records
   evidence, obtains resumable Lobster approval, and performs the real
   allowlisted rollback;
5. proves identical rollback replay is a no-op;
6. restarts the Gateway with the attempt still `running`, then read-only
   reconciliation settles it to `recovery_check`;
7. waits for the Deployment to become available and Prometheus to scrape a
   post-remediation value of `1.0`;
8. invokes the gated recovery Tool, persists `completed`, independently reads
   back the exact completed state, restarts the Gateway, and only then proves
   the recovery replay is blocked and the completed state still exists;
9. removes the cluster, scoped token, kubeconfig, Gateway state, and port
   forward.

## Sanitized proof summary (2026-08-08)

`npm run recovery:kind-prometheus-proof` passed on the workstation against a
real kind cluster and a real Prometheus server:

| Signal | Result |
|---|---|
| `degradedMetricObserved` | `0.7` |
| `degradedClassification` | `critical` |
| `rollbackDecision` | `rolled_back` |
| `rollbackMutationDispatchCount` | `1` |
| `rollbackReplayDecision` | `duplicate` |
| `restartReconciliation` | `confirmed_succeeded` |
| `deploymentHealthy` | `true` |
| `desiredReplicas` | `1` |
| `availableReplicas` | `1` |
| `prometheusHealthy` | `true` |
| `prometheusRecoveredValue` | `1` |
| `prometheusThreshold` | `0.95` |
| `recoveryReplayBlocked` | `true` |
| `incidentCompleted` | `true` |
| `completedStateSurvivedGatewayRestart` | `true` |
| Cluster cleanup | passed |

Step 4 is proven: both the Deployment and Prometheus recovery signals were
independently observed to recover, the completed incident survived a Gateway
restart, and a replayed recovery verification was blocked.
