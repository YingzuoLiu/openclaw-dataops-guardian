# Security policy

## Supported versions

DataOps Guardian is a prototype. Security fixes are applied to the latest
`0.3.x` release line only; `0.1.x` and `0.2.x` are no longer supported. No
release is approved for unattended production remediation.

## Reporting a vulnerability

Do not disclose credentials or exploit details in a public issue. Prefer
GitHub private vulnerability reporting from the repository's **Security** tab.
If private reporting is unavailable, open a minimal issue asking the maintainer
for a private contact channel without including sensitive details.

Include the affected Guardian and OpenClaw versions, operating system, install
method, reproduction steps, and the smallest sanitized log that demonstrates
the issue. Remove API keys, authorization headers, session transcripts,
internal hostnames, and production metric values.

## Security boundaries in `v0.3.0`

- Prometheus access is read-only and the endpoint is administrator-owned.
- `guardian_query_prometheus` accepts Agent-supplied PromQL up to 2,048
  characters. Its configured client timeout (five seconds by default, up to 30
  seconds) bounds how long Guardian waits, not query cost at the server;
  Guardian enforces neither a PromQL allowlist nor a query-cost budget.
  Expensive expressions can therefore load the administrator-owned endpoint.
  Restrict Tool access and apply Prometheus-side limits where appropriate.
  Recovery verification is narrower and uses only administrator-configured
  PromQL.
- Credentials embedded in `prometheusBaseUrl` are rejected.
- Bearer-token, mTLS, and cloud-provider authentication are not implemented.
- Kubernetes mutation is limited to a configured cluster context and exact
  namespace/Deployment allowlist; callers cannot supply a kubeconfig, API
  server, arbitrary patch, or shell command.
- Recovery requires the same succeeded attempt binding, matching Deployment
  UID/template/audit annotations, ready replicas, and a fresh
  administrator-owned Prometheus threshold check.
- `persistDeploymentRecoveryVerification` (`src/runtime/recovery-verification-entry.ts`)
  is a production persistence boundary, not a Tool: only trusted Gateway/operator
  code may call it. It re-reads the current `IncidentState` from the store
  immediately before validating and writing. It requires
  `approvalStatus="approved"` and `stage="recovery_check"`, binds the result to
  the latest succeeded remediation attempt and its exact target/`notBefore`,
  rejects invalid, pre-remediation, or stale `checkedAt` timestamps, and checks
  the aggregate `decision` against both live-signal booleans. It never itself
  queries Kubernetes or Prometheus. It trusts that its caller passed the
  genuine output of `verifyDeploymentAndPrometheusRecovery`; a compromised or
  buggy trusted caller could still fabricate a passing result and force an
  incident to `completed`.
- The Gateway session write path (`sessions.pluginPatch`) has no
  compare-and-swap or version check today: it is a last-write-wins update.
  Reading the current state immediately before writing (as
  `persistDeploymentRecoveryVerification` now does) closes the long
  stale-snapshot window an external poll loop would otherwise leave open, but
  it does not add real optimistic-concurrency control. Two genuinely
  concurrent writers to the same session can still race; this remains a
  residual infrastructure risk.
- The Agent response gate is bounded and can fail open after its revision
  budget; durable Reducer and Tool gates are the action boundary.
- Lobster is a shell-capable workflow runtime and receives the Gateway process
  environment. Guardian therefore blocks run-identified OpenClaw Agent Tool
  calls and, for authenticated non-Agent loopback RPC, accepts only the
  immutable `workflows/incident-remediation.lobster` request shape. Guardian
  replaces the caller's canonical path marker with the installed workflow file
  and injects its step working directory; callers cannot select either path. A
  resume token is accepted only when it resolves to persisted state for that
  same workflow and root. This hook is a request-shape boundary, not caller
  authentication: software or a model given the Gateway operator token has
  operator authority and can approve that exact workflow. Never expose that
  token to model-controlled code. The release profile must keep
  `lobsterToolPolicyMode="incident_workflow_only"`; its `disabled` value exists
  only for controlled local fixtures. `LOBSTER_STATE_DIR` is authority-bearing
  resume state: keep it private to the Gateway identity, because the upstream
  state format has no independent MAC and the hook cannot prevent a co-tenant
  filesystem writer from racing a validated resume.
- Local proof scripts bind fixtures to loopback, use isolated state and kind
  clusters, and remove temporary credentials and clusters on exit. They must
  never be pointed at a normal Gateway profile or production cluster.
- The final demo builds its stdout report from an explicit field allowlist and
  rejects secrets, tokens, kubeconfig or absolute paths, PodTemplates, and raw
  webhook/evidence payloads. It emits the full report only after the disposable
  cluster, Gateway, bridge, port-forward, run-owned local image tags,
  kubeconfigs, and temporary credentials have been removed. See
  [the final safety proof](docs/final-safety-proof.md).
- The release-image builder accepts only a clean, exact Git commit and exports
  that commit into a private context. It does not trust the Git-ignored host
  `dist/` or `node_modules/` trees, and the runtime build excludes tests,
  declarations, and source maps.
- The image pins the official OpenClaw `2026.6.34` manifest digest, runs as the
  upstream non-root `node` user under `tini`, and performs no package install
  or source download at startup. The Guardian/Lobster bundle under
  `/opt/dataops-guardian` is root-owned and non-writable to that process;
  operational configuration and state are expected to come from explicit
  mounts. The upstream `/app` tree is not made read-only by Phase 6A; a
  read-only root filesystem remains a deployment-level hardening control.
- OCI labels are descriptive metadata, not independent provenance. Treat an
  image as accepted only when the source-bound image proof has validated its
  actual runtime, labels, inventory, and saved layers for the same commit.
- The shared image deliberately has no OCI healthcheck because the upstream
  check is Gateway-specific and invalid for the Bridge role. Role-specific
  Kubernetes probes, network policy, RBAC, Secret delivery, and high
  availability remain outside Phase 6A.

Operators remain responsible for network isolation, OpenClaw channel and Tool
permissions, secret storage, log retention, and review of any future
production-mutating integration.

## Dependency and image contract for `v0.3.0`

The `v0.3.0` source pins Lobster and its OpenClaw development host to the exact
`2026.6.34` release and requires Node.js `^22.22.2`, `^24.15.0`, or `>=26`.
The OCI runtime uses the exact official OpenClaw image digest recorded in
[the release image contract](docs/release-image-contract.md), supplies that
host as Guardian's peer, and does not install a duplicate OpenClaw tree below
the plugin.

As checked on 2026-08-11, `npm audit --omit=dev --audit-level=high` reports no
high or critical findings and eleven residual findings (three low and eight
moderate) in the pinned source-install dependency tree. The separate
`container/package-lock.json` runtime layer reports no known vulnerabilities at
that threshold. The latter does not audit operating-system packages or the
OpenClaw dependency tree already present in the digest-pinned base image; review
the upstream image/SBOM separately when publishing a registry artifact.

The full development tree reports 17 findings: three low, twelve moderate, and
two high-severity findings in the Vitest/Vite test-tool chain. The high findings
are not shipped in the container runtime dependency layer. Do not run
`npm audit fix --force` or add unreviewed dependency overrides: either action
can silently replace the versions exercised by the safety proof. Re-run the
source, container-lock, base-image, and full-development audits when cutting a
release, record any changed advisory set, and separately review upstream fixes.
