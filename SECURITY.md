# Security policy

## Supported versions

DataOps Guardian is a prototype. Security fixes are applied to the latest
`0.2.x` release line only; `0.1.x` is no longer supported. No release is
approved for unattended production remediation.

## Reporting a vulnerability

Do not disclose credentials or exploit details in a public issue. Prefer
GitHub private vulnerability reporting from the repository's **Security** tab.
If private reporting is unavailable, open a minimal issue asking the maintainer
for a private contact channel without including sensitive details.

Include the affected Guardian and OpenClaw versions, operating system, install
method, reproduction steps, and the smallest sanitized log that demonstrates
the issue. Remove API keys, authorization headers, session transcripts,
internal hostnames, and production metric values.

## Security boundaries in `v0.2.0`

- Prometheus access is read-only and the endpoint is administrator-owned.
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
- Local proof scripts bind fixtures to loopback, use isolated state and kind
  clusters, and remove temporary credentials and clusters on exit. They must
  never be pointed at a normal Gateway profile or production cluster.
- The final demo builds its stdout report from an explicit field allowlist and
  rejects secrets, tokens, kubeconfig or absolute paths, PodTemplates, and raw
  webhook/evidence payloads. It emits the full report only after the disposable
  cluster, Gateway, bridge, port-forward, run-owned local image tags,
  kubeconfigs, and temporary credentials have been removed. See
  [the final safety proof](docs/final-safety-proof.md).

Operators remain responsible for network isolation, OpenClaw channel and Tool
permissions, secret storage, log retention, and review of any future
production-mutating integration.

## Dependency audit for `v0.2.0`

The `v0.2.0` release pins OpenClaw and Lobster to the exact extended-stable
`2026.6.34` release and requires Node.js `^22.22.2`, `^24.15.0`, or `>=26`.
As checked on 2026-08-08, `npm audit --omit=dev` reports no high or critical
production vulnerabilities. Eleven low/moderate findings remain in OpenClaw's
transitive dependency tree and have no fix available without changing the
direct OpenClaw/Lobster contract.

The full development tree additionally reports two high-severity findings in
the Vitest/Vite test-tool chain. They are not shipped as production
dependencies. Do not run `npm audit fix --force` or add unreviewed dependency
overrides: either action can silently replace the versions exercised by the
safety proof. Re-run both the production and full audits when cutting a release,
record any changed advisory set, and separately review upstream fixes.
