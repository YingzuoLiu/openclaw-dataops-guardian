# Day 0 result — 2026-07-25

Status: **passed**

Day 0 now proves that the actual OpenClaw Gateway plugin execution context can
use a temporary, scoped kubeconfig to reach an isolated kind API server, read
one allowlisted Deployment, perform one controlled reversible write, and remain
blocked from resources outside its static and RBAC boundaries.

## Repository baseline

- Branch: `spike/v0.2-day0-kind-connectivity`
- Base `main`: `fd258fc4a5647464438b32ab9cff23ff06a53aef`
- `v0.1.0` tag: `0e2d4dbb6a571872a41bcc0d7d02f04e97b9deec`
- v0.1 build: passed
- v0.1 tests: 10 files, 39 tests passed
- spike tests: 3 tests passed

No v0.1 product source, A/B evidence, workflow, README, version, tag, or
release metadata was changed.

## Phase 1: cloud environment preflight

The first run in the cloud workspace did not pass its infrastructure preflight:

- Linux `6.12.13`, x64
- Node.js `v24.14.0`
- Docker, kind, and kubectl commands unavailable
- Docker, containerd, and podman sockets unavailable
- `CAP_SYS_ADMIN` unavailable
- mount namespace creation (`unshare`) denied

That environment could not start kind or a nested container runtime. The full
proof stopped before kubeconfig creation, certificate loading, API server
connection, or Kubernetes authorization. This remains useful failure evidence
in `artifacts/preflight.json`; the file is intentionally preserved unchanged.

The cloud run still verified the spike unit tests and a live Gateway
deny-before-access path: an outside target was rejected by the plugin allowlist
even when the configured kubeconfig path did not exist.

## Phase 2: local Windows 11, WSL2, and Docker Desktop rerun

The complete proof passed in this local environment:

- Windows 11 with WSL2 kernel
  `6.18.33.2-microsoft-standard-WSL2`
- Node.js `v22.22.1`
- Docker Desktop `4.83.0`
- Docker Engine `29.6.2`
- kind `v0.32.0`
- kubectl client `v1.36.1`
- OpenClaw `2026.6.9`

The successful lifecycle was:

1. start the isolated `guardian-day0` kind cluster;
2. create namespace `guardian-day0`;
3. create Deployment `payments-day0`;
4. create a ServiceAccount, resource-scoped Role, and RoleBinding;
5. generate a temporary one-hour service-account token and scoped kubeconfig;
6. start a real OpenClaw Gateway with the spike plugin linked;
7. read the scoped kubeconfig from the Gateway process;
8. connect to the loopback kind API server;
9. read the allowlisted Deployment and record UID/resourceVersion;
10. replace the fixed `guardian.openclaw.dev/day0-spike` annotation;
11. observe the write and restore the original value in `finally`;
12. reject an outside target in the plugin before Kubernetes access;
13. observe HTTP 403 when the scoped credentials access another namespace;
14. delete the kind cluster and temporary runtime files.

The successful proof is recorded in:

- `artifacts/preflight-local-wsl.json`
- `artifacts/day0-kind-proof.json`

Neither artifact contains a token, certificate, kubeconfig, private key, or
user-specific absolute path. The temporary loopback API server address,
Gateway PID, Deployment UID, and resourceVersion are retained as non-secret
execution evidence.

## Acceptance status

| Day 0 condition | Result |
|---|---|
| kind cluster starts | Passed |
| one-time namespace created | Passed |
| test Deployment created | Passed |
| Gateway reads test kubeconfig | Passed |
| Gateway connects to API server | Passed |
| specified namespace read | Passed |
| specified Deployment read | Passed |
| controlled reversible write | Passed; observed and restored |
| outside namespace/resource denied | Passed; plugin allowlist and Kubernetes RBAC |
| test resources cleaned | Passed; cluster and temporary runtime removed |

## Scope and limitations

This proof uses an isolated local kind cluster. It does not establish production
Kubernetes support and does not validate EKS, GKE, AKS, production credentials,
multi-cluster operation, or unattended remediation.

The write was a fixed, reversible annotation patch used only to prove execution
context, network reachability, scoped kubeconfig loading, Kubernetes RBAC, and a
controlled mutating path. A real Deployment rollback has not been implemented.
No model-generated patch, arbitrary kubectl, shell execution, or arbitrary
namespace/resource access was introduced.

## Decision

Day 0 is passed. The network and permission risk is sufficiently retired to
allow v0.2 Step 1 (IncidentState schema v3) to begin in a separate, explicitly
approved phase.

This Day 0 update does not begin Step 1, Alertmanager ingestion, or the complete
Kubernetes remediation workflow.
