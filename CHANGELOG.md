# Changelog

All notable changes to DataOps Guardian are recorded here. The project follows
semantic versioning for its source tags; it is not published to npm or ClawHub.

## [0.2.0] - 2026-08-08

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
- WSL-safe temporary plugin staging for Windows-mounted checkouts, explicit
  exclusion of unrelated bundled extensions, phase-only progress, bounded
  component deadlines, caller-profile isolation, and active-component
  diagnostics on failed proof runs.

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

[0.2.0]: https://github.com/YingzuoLiu/openclaw-dataops-guardian/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/YingzuoLiu/openclaw-dataops-guardian/tree/v0.1.0
