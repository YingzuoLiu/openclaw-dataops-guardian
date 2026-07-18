# OpenClaw DataOps Guardian

Compatibility-first prototype for a DataOps incident investigation workflow on
OpenClaw.

The first milestone is deliberately narrow: prove that plugin-owned incident
state works on `openclaw@2026.6.9` before implementing investigation tools or
remediation workflows.

## Proof 2: session extension compatibility

The spike must demonstrate all of the following against an isolated Gateway:

1. register the `dataops-guardian/incident` session extension;
2. write JSON-compatible state through `sessions.pluginPatch`;
3. observe the projected value in the session row;
4. restart the Gateway and observe the same value;
5. reset the session and observe that the extension state is cleared.

Proof 2 passed locally on 2026-07-18. See
[`docs/proof-2-session-extension.md`](docs/proof-2-session-extension.md) for the
assertions, reproducible fixture, and version-specific findings.

The follow-on compatibility proofs also passed:

- [Proof 1: tool loading and invocation](docs/proof-1-tool-loading.md)
- [Proof 3: Lobster approval recovery](docs/proof-3-lobster-approval.md)

The compatibility risks are retired and the first narrow slice below is now
implemented. It remains a prototype: the alert value comes from a read-only
Prometheus instant query, while the Lobster workflow performs only synthetic
local remediation and recovery steps.

## First vertical slice

The first end-to-end slice is now implemented and verified:

```text
metric alert -> evidence -> proposal -> approval -> remediation -> recovery
```

Both approve (`completed`) and deny (`blocked`) paths persist through the native
session extension. The approval token also survives a Gateway restart. See
[the vertical slice report](docs/vertical-slice.md).

The Prometheus endpoint is administrator configuration, not a Tool argument.
The Agent supplies only PromQL, and Guardian requires the query to return
exactly one finite sample. See [the adapter contract](docs/prometheus-adapter.md).

Run the isolated approved-path proof with:

```bash
npm run slice:proof
```

The proof starts its own loopback-only mock Prometheus API and does not require
or contact a production monitoring system.

## Version contract

- Node.js `>=22.19.0`
- OpenClaw `2026.6.9` for the compatibility spike
- Lobster plugin `2026.6.9` for the approval compatibility spike
- Plugin/Gateway compatibility floor `>=2026.6.9`

The production compatibility range can be widened only after the proof is
repeated on newer stable releases.

## Local checks

```bash
npm install
npm run check
```

The live Gateway proof intentionally needs an isolated OpenClaw state directory
and a short-lived test-only authentication configuration. Follow the documented
procedure rather than pointing it at a normal OpenClaw profile.
