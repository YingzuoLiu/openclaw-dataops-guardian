# OpenClaw DataOps Guardian

[![CI](https://github.com/YingzuoLiu/openclaw-dataops-guardian/actions/workflows/ci.yml/badge.svg)](https://github.com/YingzuoLiu/openclaw-dataops-guardian/actions/workflows/ci.yml)

Guardian is an OpenClaw `2026.6.9` plugin prototype that combines
run-scoped evidence accounting with durable Tool and Reducer gates.

In a paired 24-trial real-model A/B evaluation, the language-only baseline
released 3 unsupported conclusions in 12 trials under adversarial pressure,
while the gated arm released 0 in 12. All observed failures were confined to
one deliberately adversarial scenario, so this is a narrow reproducible result,
not a production failure-rate claim.

> **Prototype boundary:** Guardian collects read-only Prometheus evidence and
> creates deterministic remediation proposals. The included remediation and
> recovery steps are synthetic and do not mutate production.

For installation, dedicated-profile configuration, runtime verification, and
safe removal, see the [Operator guide](docs/operator-guide.md). Security reports
and supported-version policy are documented in [SECURITY.md](SECURITY.md).

## What this repository demonstrates

- native OpenClaw session-extension incident state that survives Gateway
  restart;
- a read-only Prometheus Tool whose endpoint remains administrator-owned;
- durable Reducer, Tool-call, and bounded response gates for evidence-backed
  remediation proposals;
- resumable Lobster approval with deterministic synthetic remediation;
- a live Gateway Hook proof and a 24-trial real-model A/B evaluation with raw
  evidence and explicit limitations.

## Compatibility-first development path

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

The incident state is now schema version 2. A proposal can enter `approval`
only after fresh Prometheus evidence passes the Reducer policy. The plugin also
registers `before_agent_run`, `before_tool_call`, `after_tool_call`,
`before_agent_finalize`, and the `agent_end` cleanup hook. In an explicitly
configured dedicated Guardian profile, the generic `require_tools` validator
is active before the model's first turn, so both partial Tool use and zero-Tool
final answers are covered.
Unsupported natural answers receive one bounded revision pass, while the Tool
and Reducer gates continue to prevent unsupported proposals and approval. See
[the evidence gate contract](docs/evidence-gates.md).

The Prometheus endpoint is administrator configuration, not a Tool argument.
The Agent supplies only PromQL, and Guardian requires the query to return
exactly one finite sample. See [the adapter contract](docs/prometheus-adapter.md).

Run the isolated approved-path proof with:

```bash
npm run slice:proof
```

The proof starts its own loopback-only mock Prometheus API and does not require
or contact a production monitoring system.

Run the loader-backed hook registration proof with:

```bash
npm run policy:proof
```

Run the zero-cost real Gateway Agent invocation proof with:

```bash
npm run hooks:live-proof
```

It uses a loopback scripted model that deliberately skips every Tool and
asserts one bounded revision from the live `before_agent_finalize` response
path. See [the live hook invocation report](docs/live-hook-invocation.md).

The real-model, independent-trial OpenRouter A/B milestone is complete. Across
24 trials with `openrouter/openai/gpt-4.1-mini`, baseline runs released three
unsupported conclusions while gated runs released none. All three gated
revisions were honored. The recorded cost was USD 0.096116.

This result demonstrates a bounded behavioral improvement, not a statistical
or semantic-correctness guarantee. See the
[formal result and manual interpretation](docs/openrouter-ab-formal-result.md)
and the [machine-readable result](evals/openrouter-ab/formal-2026-07-19.json).

The runner pairs byte-identical baseline/gated prompts, isolates every session,
retains prompt/transcript/Tool/Hook evidence, and stops at a configured cost
budget. Preview the no-cost schedule with:

```bash
npm run eval:openrouter:plan
```

See [the evaluation contract](docs/openrouter-ab-evaluation.md). Re-running paid
trials remains opt-in and requires `OPENROUTER_API_KEY` in the caller's
environment, or the same-named GitHub Actions repository secret for the manual
workflow.

## Version contract

- Node.js `>=22.19.0`
- OpenClaw `2026.6.9` for the compatibility spike
- Lobster plugin `2026.6.9` for the approval compatibility spike
- Plugin/Gateway compatibility floor `>=2026.6.9`

The production compatibility range can be widened only after the proof is
repeated on newer stable releases.

## Local checks

```bash
npm ci
npm run check
```

The live Gateway proof intentionally needs an isolated OpenClaw state directory
and a short-lived test-only authentication configuration. Follow the documented
procedure rather than pointing it at a normal OpenClaw profile.
