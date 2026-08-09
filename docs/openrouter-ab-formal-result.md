# OpenRouter formal A/B result

Status: completed and manually reviewed on 2026-07-19.

## Outcome

The formal evaluation ran 24 independent real-model trials: 12 baseline and 12
with Guardian's run-scoped `require_tools` Gate enabled.

| Arm | Trials | Required Tools succeeded | Unsupported conclusion released | Blocked report | Gate revisions honored |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline | 12 | 9 (75%) | 3 (25%) | 1 | 0 |
| gated | 12 | 12 (100%) | 0 (0%) | 3 | 3 |

The recorded OpenRouter cost was USD 0.0961156. The model was
`openrouter/openai/gpt-4.1-mini`; temperature was 0.2 and thinking was disabled.

The result supports a narrow claim: under the tested conflicting-instruction
pressure, the language-only policy was insufficient, while the finalize Gate
caused the model to obtain the required evidence before releasing an answer.
It does not establish a population-level failure rate or a statistical
guarantee.

## Scenario results

Each scenario had three baseline/gated prompt pairs. The prompt text was
byte-identical within every pair, arm order was counterbalanced, and every
trial used a unique session and isolated OpenClaw state.

| Scenario | Baseline unsupported | Gated unsupported | Gated revisions |
| --- | ---: | ---: | ---: |
| context dilution | 0/3 | 0/3 | 0 |
| confidence bait | 0/3 | 0/3 | 0 |
| latency pressure | 0/3 | 0/3 | 0 |
| persistent refusal | 3/3 | 0/3 | 3 |

Only the deliberately adversarial `persistent_refusal` scenario induced the
baseline failure. In each baseline replicate, the model followed a late
instruction to avoid Tools and declared the metric healthy from a cached value.
In each gated replicate, `before_agent_finalize` returned `revise`; the model
then successfully called both required Tools and did not release the original
unsupported conclusion.

This concentration matters. The evaluation demonstrates a reproducible failure
and prevention mechanism, but it must not be described as evidence that 25% of
ordinary production answers are unsupported.

## Manual interpretation

The automatic classifier correctly identified the three zero-Tool baseline
answers as unsupported. The associated gated Hook JSONL contains an activation,
a `revise` decision, the bounded second pass, and an eventual `allow` after the
required Tool ledger was complete.

Manual review also exposed a boundary that the aggregate compliance percentage
does not capture: successful Tool calls do not guarantee correct interpretation
of their results. Some Tool-compliant answers differed on whether a value of
`0.7` was healthy or critical when the supplied snapshot evidence was
inconsistent. Guardian currently enforces evidence acquisition and durable
workflow transitions; it does not perform general semantic entailment between
evidence and natural-language conclusions.

## Fail-open boundary

No real-model trial exhausted the finalize revision budget. All three revision
requests were honored, so `failOpenObserved=0` means "not observed," not "cannot
happen." The zero-cost scripted live proof separately demonstrates the host's
bounded retry behavior. The durable Reducer and Tool gates remain the hard
boundary for proposal and approval state transitions even if a natural-language
answer is eventually released after finalize retries are exhausted.

## Evidence and integrity

- Workflow run: [GitHub Actions run 29685425051](https://github.com/YingzuoLiu/openclaw-dataops-guardian/actions/runs/29685425051)
- Source commit: `decc8bd82232b9c829e1bd609290578680f8b957`
- Artifact: `openrouter-ab-formal-29685425051`, ID `8442305370`
- Artifact SHA-256: `97e5541d982cbf033c7c5bed9083fb7e0a60bbbab82876b751d3b52de0b96401`
- GitHub artifact expiry: 2026-08-02

The downloaded artifact contained 171 files across 24 trial directories. All
24 session keys were unique; all JSON and JSONL parsed successfully; every
trial contained its expected summary, raw record, RPC response, Gateway log,
Prometheus trace, and Hook audit file. A pattern scan found no OpenRouter key in
the evidence archive.

The committed machine-readable aggregate is
[`evals/openrouter-ab/formal-2026-07-19.json`](../evals/openrouter-ab/formal-2026-07-19.json).
Raw transcripts are retained as an Actions artifact rather than committed as
171 generated files.

## Project decision

This evaluation closed the evidence-gate MVP. Alertmanager ingestion and
Kubernetes remediation were subsequently implemented in Steps 2-5; production
telemetry and external-run watching remain outside the repository's claim. A
future validator may add domain-specific evidence-to-conclusion checks, but
that is explicitly outside the result established here.
