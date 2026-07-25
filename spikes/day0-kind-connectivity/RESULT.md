# Day 0 result — 2026-07-25

Status: **not passed; stop before v0.2 implementation**

## Repository baseline

- Local branch: `spike/v0.2-day0-kind-connectivity`
- Base `main`: `fd258fc4a5647464438b32ab9cff23ff06a53aef`
- `v0.1.0` tag: `0e2d4dbb6a571872a41bcc0d7d02f04e97b9deec`
- Baseline build: passed
- Baseline tests: 10 files, 39 tests passed

No v0.1 product source, A/B evidence, workflow, README, version, tag, or
release metadata was changed.

## Execution environment

- Linux `6.12.13`, x64
- Node.js `v24.14.0`
- OpenClaw `2026.6.9`
- Docker command: unavailable
- kind command: unavailable
- kubectl command: unavailable
- Docker/containerd/podman sockets: unavailable
- `CAP_SYS_ADMIN`: unavailable
- mount namespace creation (`unshare`): denied

This environment cannot start kind directly and cannot start a nested container
runtime. The failure occurs before kubeconfig creation, certificate loading, API
server connection, or Kubernetes authorization.

## What was implemented and verified

The spike is an independent OpenClaw plugin under this directory. It is not
imported by or registered in the v0.1 `dataops-guardian` product plugin.

Verified here:

- `@kubernetes/client-node@1.4.0` installs in the isolated spike package.
- Three spike tests pass:
  - outside targets are rejected before a Kubernetes client is created;
  - the allowlisted Deployment read is summarized without exposing credentials;
  - a controlled annotation patch is observed and restored in `finally`.
- A live OpenClaw Gateway loaded `guardian_day0_kind_connectivity`.
- Through Gateway `tools.invoke`, `default/outside-day0` was denied by the
  static allowlist even though the configured kubeconfig path did not exist.
  This proves the denial occurs inside the Gateway plugin path and before
  kubeconfig or Kubernetes API access.
- The full proof entrypoint stopped at preflight with exit code 2.
- No kind resource was created, and all temporary Gateway state was removed.

Not verified here:

- kind cluster startup;
- reading a real scoped kubeconfig from the Gateway process;
- API server reachability;
- reading the real `guardian-day0/payments-day0` Deployment;
- the real reversible annotation patch;
- Kubernetes RBAC returning HTTP 403 outside the namespace.

## Acceptance status

| Day 0 condition | Result |
|---|---|
| kind cluster starts | Not reached |
| one-time namespace created | Not reached |
| test Deployment created | Not reached |
| Gateway reads test kubeconfig | Not reached |
| Gateway connects to API server | Not reached |
| specified namespace read | Not reached |
| specified Deployment read | Not reached |
| controlled reversible write | Mock-tested only; not accepted |
| outside namespace/resource denied | Gateway allowlist passed; cluster RBAC not reached |
| test resources cleaned | Passed vacuously; none created, temporary state removed |

## Kubeconfig and boundary design for the rerun

The full script creates a one-hour service-account token and an absolute
temporary kubeconfig. RBAC grants only `get` and `patch` on Deployment
`payments-day0` in namespace `guardian-day0`. The Gateway receives only the
temporary kubeconfig path through administrator plugin configuration. The tool
does not accept kubeconfig, API server, token, namespace allowlist, patch
content, or shell command as free-form inputs.

The controlled write replaces only
`guardian.openclaw.dev/day0-spike`, verifies the change, and restores the prior
value using `resourceVersion` and JSON Patch `test` operations.

## Decision

Do not proceed to Alertmanager ingestion, IncidentState schema v3, or the real
rollback workflow yet.

Rerun from a shell where Docker, kind, and kubectl are available to the same
OpenClaw Gateway process:

```bash
bash spikes/day0-kind-connectivity/run-day0-kind-spike.sh
```

If that environment can create kind but the Gateway still cannot reach its API
server, classify the specific network or sandbox failure and move Kubernetes
access to a separate, deterministic remediation worker outside the plugin.
