# Proof Replay Demo Adapter

This directory is a read-only interview presentation layer:

```text
validated sanitized proof report
  -> demo/projection.mjs
  -> local Demo Console
```

The adapter maps an allowlisted core proof report into a small, stable display
model. It does not read internal database tables, call Guardian Tools, rerun an
Evidence Gate, approve a workflow, connect to Kubernetes, or decide that an
incident recovered.

## Display source

The main replay source is
[`artifacts/validated-final-proof.json`](artifacts/validated-final-proof.json),
an exact copy extracted from the successful GitHub Actions artifact
`guardian-final-proof-31552595287-1`:

- workflow run: [CI run #50](https://github.com/YingzuoLiu/openclaw-dataops-guardian/actions/runs/31552595287);
- source commit: `f480dcf99ee9dedcaa61ecf9e21332c8260377db`;
- disposable environment: kind, real Prometheus, and real Lobster;
- artifact archive SHA-256:
  `07972fc348a1bcd426a0f8d06cfe656c480e8680b5420a895dd48ae4e74bcbeb`;
- validated report SHA-256:
  `41b1b560c2197ecaee9ab3e707ee9981608cc871a39b19fd32eca7482b432d88`.

`provenance.json` binds the checked-in report to that commit and digest. The
adapter refuses to start if the report bytes no longer match the recorded
SHA-256.

The source report is an aggregate, sanitized acceptance artifact—not a
timestamped event log. The Console therefore labels its ordered timeline as a
presentation projection. It exposes exact JSON field pointers and source
fragments for each observation. It does not invent incident identifiers,
targets, timestamps, or raw webhook content.

The full proof's temporary `audit.jsonl` and component logs were intentionally
not retained by the validated artifact contract. The Console's Audit / proof
JSON panel displays the exact sanitized acceptance report and says so; it does
not present a handwritten audit fixture as live kind evidence.

## Run

```bash
npm ci
npm run demo
```

The server binds to `127.0.0.1`, prints its URL, and normally opens a browser.
Set `DEMO_NO_OPEN=1` to suppress browser launch or `DEMO_PORT` to choose a
port. Runtime assets and data are local; starting the Console makes no external
request.

To regenerate the real disposable-cluster proof instead of replaying the
checked-in artifact, use:

```bash
npm run proof:full
```

That command retains the original Step 5 prerequisites and safety contract. It
is deliberately separate from the interview Console.
