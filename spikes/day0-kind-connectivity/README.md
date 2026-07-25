# Day 0: OpenClaw Gateway to kind connectivity

This directory is a disposable spike. It does not modify or extend the
`dataops-guardian` product plugin.

## What the full proof verifies

The proof creates a temporary kind cluster and:

1. creates namespace `guardian-day0`;
2. creates Deployment `payments-day0` with zero replicas;
3. creates a one-hour service-account token and a namespace-scoped kubeconfig;
4. starts an actual OpenClaw Gateway with this spike plugin linked;
5. invokes the spike through Gateway `tools.invoke`;
6. reads the allowlisted Deployment from inside the Gateway process;
7. replaces one fixed annotation, observes the write, and restores its original
   value in `finally`;
8. proves the plugin rejects an outside target before Kubernetes access;
9. proves the scoped credentials receive HTTP 403 outside the namespace;
10. deletes the kind cluster and temporary kubeconfigs.

The write target is hard-coded:

```text
namespace: guardian-day0
deployment: payments-day0
annotation: guardian.openclaw.dev/day0-spike
```

No kubeconfig, token, certificate, or shell command is accepted as tool input.

## Requirements

- Node.js compatible with the repository
- Docker daemon reachable from the same shell
- kind
- kubectl

From the repository root:

```bash
bash spikes/day0-kind-connectivity/run-day0-kind-spike.sh
```

Safe, redacted results are written under `artifacts/`. Kubeconfigs and Gateway
state stay in a temporary directory and are removed on exit.

When kind is unavailable, the live Gateway allowlist boundary can still be
verified without touching Kubernetes:

```bash
bash spikes/day0-kind-connectivity/run-deny-only-proof.sh
```

That partial proof is not a substitute for the full Day 0 acceptance test.
