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

- Node.js `>=22.19.0`;
- npm with lockfile support;
- OpenClaw compatibility fixed at `2026.6.9` unless a dedicated compatibility
  proof widens that range.

Install and run the deterministic checks:

```bash
npm ci
npm run check
```

Use the isolated proofs only with their generated test profiles:

```bash
npm run policy:proof
npm run hooks:live-proof
npm run slice:proof
```

Paid OpenRouter evaluation is opt-in and is not required for ordinary pull
requests. Never put an API key in repository config or command output.

## Pull requests

- Explain the invariant or compatibility risk being changed.
- Add or update tests for failure paths and idempotency.
- Document security boundaries and any production mutation.
- Keep unrelated cleanup out of the same change.
- Confirm `npm run check` passes.

Production-mutating remediation, new credential handling, and broader network
access require an explicit design and threat-model review before implementation.
