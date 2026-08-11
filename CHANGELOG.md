# Changelog

All notable changes to DataOps Guardian are recorded here. The project follows
semantic versioning for its source tags; it is not published to npm or ClawHub.

## [0.3.0] - 2026-08-11

### Added

- A reproducible Linux/amd64 OCI build from an exact clean Git commit, using a
  digest-pinned official OpenClaw `2026.6.34` image and immutable Guardian and
  Lobster runtime paths.
- A non-root, `tini`-preserving role dispatcher for the bundled Gateway and
  standalone Alertmanager bridge, with role-specific preflight checks and
  fail-closed handling of unknown roles, missing artifacts, configuration,
  secrets, and state directories.
- A runtime-only TypeScript build that excludes tests, declarations, source
  maps, host `dist/`, and host `node_modules`, plus an allowlisted Docker build
  context.
- A separate OCI image CI contract that inspects metadata and effective Node
  version, starts both roles, verifies Guardian's five Tools and five Hooks,
  exercises negative startup cases, and scans saved image layers for a host
  sentinel.
- A tag-triggered source-release contract that resolves the real remote tag,
  performs a fresh shallow clone, restores the lockfile, builds, verifies
  linked runtime registration, and exercises approval/resume across a complete
  Gateway restart.

### Changed

- OpenClaw is now an optional host peer with an exact development dependency,
  preventing a second OpenClaw runtime from being bundled into the image.
- Bridge integer environment variables now require a canonical positive
  integer, validate the port range, and reject suffixes or unsafe values.
- Bridge startup now proves its state directory can durably create, sync, and
  remove a file before connecting to the Gateway or opening the HTTP listener.
- The OCI proof runs the real Lobster approval workflow, restarts the Gateway,
  and resumes from the persisted approval token before starting the Bridge.

### Security

- The image is built from archived committed source rather than the live
  worktree or ignored build output, and final stages use explicit copies only.
- OCI source/revision labels and immutable build metadata are checked against
  the exact commit by the wrapper and CI; labels alone are not treated as
  provenance.
- The upstream Gateway-only healthcheck is explicitly disabled for the
  dual-role image so a Bridge container is not falsely reported unhealthy.
  Workload-specific probes remain Phase 6B scope.
- Raw Lobster shell pipelines are blocked by a default-on Guardian hook.
  Run-identified Agent calls are blocked; authenticated non-Agent loopback
  calls are restricted to the immutable incident workflow, whose file and step
  root are injected by Guardian rather than selected by the caller; resume
  tokens must bind to persisted state for that workflow and root.
- Bridge webhook and Gateway operator credentials must be distinct, and the
  image proof verifies read-only Bridge state fails before any connection or
  listener is opened.

## [0.2.0] - 2026-08-09

### Added

- Durable IncidentState v3 occurrence identity, attempt history, and restart
  reconciliation.
- Authenticated Alertmanager v4 ingestion with bounded deduplication, durable
  routing/checkpoints, and crash-safe replay.
- Real Lobster approval and an administrator-allowlisted Kubernetes Deployment
  rollback with audit annotations and idempotency.
- Dual Deployment and fresh Prometheus recovery verification before
  `completed`.
- No-cost `demo:fast` and a one-cluster `demo` with positive and negative safety
  cases, an allowlisted JSON report, and explicit cleanup verification.
- Commit-bound WSL proof capsules for Windows-mounted checkouts, explicit
  exclusion of unrelated bundled extensions, phase-only progress, bounded
  component deadlines, lockfile-based native dependency restoration, stamped
  single-build artifact reuse, batched proof
  configuration, automatic native-filesystem proof re-execution, caller-profile
  isolation, and active-component diagnostics on failed proof runs.
- Exact-head CI acceptance that runs the complete one-cluster demo and retains
  its sanitized, source-bound report.
- Deferred Kubernetes SDK loading so plugin inspection and Gateway registration
  do not import the generated Kubernetes API graph before a real cluster
  operation requests a client.

### Security

- Recovery persistence now requires an approved recovery state, the latest
  succeeded attempt, exact target/`notBefore` binding, a valid fresh
  `checkedAt`, and an internally consistent aggregate decision. Completion is
  independently read back from the Gateway session store before it is accepted,
  then replay-tested after a fresh Gateway restart.
- OpenClaw and Lobster are pinned to the exact extended-stable `2026.6.34`
  release. The 2026-08-08 production audit has no high or critical findings;
  known residual low/moderate upstream advisories are documented in
  `SECURITY.md`.
- The final proof covers denial, ambiguous restart, off-target and scoped-RBAC
  rejection, mutation and recovery replay protection, resolved-is-not-recovery,
  scale-to-zero, report sanitization, and cleanup.

## [0.1.0] - 2026-07-19

- Initial OpenClaw compatibility, Prometheus evidence-gate, Lobster approval,
  and synthetic vertical-slice prototype.

[0.3.0]: https://github.com/YingzuoLiu/openclaw-dataops-guardian/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/YingzuoLiu/openclaw-dataops-guardian/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YingzuoLiu/openclaw-dataops-guardian/tree/v0.1.0
