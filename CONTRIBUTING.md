# Contributing

DataOps Guardian is currently a narrow reference implementation. Contributions
should preserve its evidence-first and compatibility-first boundaries.

## Before opening a change

- Use an issue to describe a behavioral change or new production integration.
- Keep credentials, production endpoints, internal logs, and user transcripts
  out of issues, commits, fixtures, and test output.
- Report security problems through the process in [SECURITY.md](SECURITY.md),
  not a public issue.

## Development

Requirements:

- Node.js `22.22.2+` on the Node 22 line, `24.15.0+` on Node 24, or Node 26+;
- npm with lockfile support;
- OpenClaw compatibility fixed at `2026.6.34` unless a dedicated compatibility
  proof widens that range.

Install and run the deterministic checks:

```bash
npm ci
npm run check
npm run demo:fast
```

`demo:fast` is no-cost and uses no Docker, Kubernetes cluster, paid API, or
external model. Use individual component proofs only with their generated test
profiles:

```bash
npm run policy:proof
npm run hooks:live-proof
npm run slice:proof
```

Paid OpenRouter evaluation is opt-in and is not required for ordinary pull
requests. Never put an API key in repository config or command output.

Changes to Alertmanager ingress, approval, Kubernetes mutation, restart
reconciliation, recovery, report sanitization, or cleanup must also run the
full disposable-cluster proof on Linux/WSL with Docker, `kind`, and `kubectl`:

```bash
npm run proof:full
```

Never repoint this proof command at an existing or production cluster. The
offline `npm run demo` Console replays a checked-in sanitized artifact and is
not a substitute for this integration proof.

## Pull requests

- Explain the invariant or compatibility risk being changed.
- Add or update tests for failure paths and idempotency.
- Document security boundaries and any production mutation.
- Keep unrelated cleanup out of the same change.
- Confirm `npm run check` and `npm run demo:fast` pass.
- For changes to the live integration boundaries listed above, include the
  sanitized `npm run proof:full` result.

Production-mutating remediation, new credential handling, and broader network
access require an explicit design and threat-model review before implementation.
