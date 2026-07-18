# Evidence and retry gates

Status: **passed** locally on 2026-07-18 with `openclaw@2026.6.9`.

Guardian uses four related gates. They defend different boundaries and should
not be treated as interchangeable.

| Gate | State used | Enforced outcome |
| --- | --- | --- |
| Incident Reducer | Durable session-extension evidence | Refuses `validation -> approval`; returns to `evidence_collection` |
| `before_agent_run` | Explicit dedicated-profile configuration | Activates `require_tools` before the model can skip every Guardian Tool |
| `before_tool_call` | Successful Guardian Tools in the active run | Blocks `guardian_propose_remediation` until required Tools succeeded |
| `before_agent_finalize` | Successful Guardian Tools in the active run | Requests one bounded model revision before accepting an unsupported conclusion |

## Durable approval invariant

`recordRemediationProposal` evaluates evidence before setting a proposal or
requesting approval. The default policy requires:

- at least one evidence record;
- at least one source beginning with `prometheus:`;
- a valid observation timestamp no more than five minutes old;
- no observation more than 30 seconds in the future.

Failure is represented in schema-version-2 incident state:

```json
{
  "stage": "evidence_collection",
  "proposedAction": null,
  "approvalStatus": "not_requested",
  "evidenceValidation": {
    "status": "failed",
    "checkedAt": "2026-07-18T00:05:00.000Z",
    "issues": ["required evidence source is missing: prometheus:"]
  }
}
```

This is the hard business invariant. Even if an RPC client bypasses an Agent
hook, the Reducer will not persist an unsupported transition to approval.

## Agent Tool and response gates

For an Agent-driven Guardian run, `before_agent_run` activates the validator
before the model receives its first prompt when the dedicated profile sets:

```bash
openclaw config set \
  plugins.entries.dataops-guardian.config.enforceRequireToolsOnAgentRuns true
```

This opt-in is intentionally disabled by default because the plugin is loaded
globally; operators should enable it only for a dedicated Guardian profile.
Once active, `after_tool_call` records successful Tool names in OpenClaw's
run-scoped plugin context. The required set is:

```text
guardian_query_prometheus
guardian_inspect_metric_snapshot
```

`before_tool_call` blocks `guardian_propose_remediation` while either is
missing. Failed Tool calls do not count as evidence.

When a Guardian run tries to finalize without the same required set,
`before_agent_finalize` returns `action: "revise"` with a stable idempotency key
and `maxAttempts: 1`. The revision instruction requires the missing Tool or an
explicitly blocked conclusion when evidence cannot be obtained.

This finalize hook is intentionally bounded. Under OpenClaw's native contract,
the host continues with the natural answer after the revision budget is
exhausted; it is not a permanent message-delivery veto. Production safety comes
from the durable Reducer and Tool-call gates, which prevent unsupported approval
and action even if prose is imperfect.

Without the dedicated-profile opt-in, the response gate activates only after a
run touches a `guardian_*` Tool, so unrelated OpenClaw conversations are not
altered. With the opt-in, even a zero-Tool final answer is evaluated.

Each activation and finalize decision emits one sanitized JSON object through
the plugin logger. It contains only the run id, hook, decision, required/missing
Tool names, failed Tool names, and timestamp—never prompts, answers, credentials,
or Tool payloads. The model-level evaluation harness will retain these records
as JSONL raw evidence.

## Non-bundled plugin permission

OpenClaw requires explicit operator consent before a non-bundled plugin may use
conversation hooks:

```bash
openclaw config set \
  plugins.entries.dataops-guardian.hooks.allowConversationAccess true
```

Without this setting, OpenClaw loads the two Tool hooks but rejects the
conversation hooks with a diagnostic. `npm run policy:proof` creates an
isolated profile, applies the setting, runs runtime inspection, and asserts:

```json
{
  "ok": true,
  "hookCount": 4,
  "typedHooks": [
    "after_tool_call",
    "before_agent_finalize",
    "before_agent_run",
    "before_tool_call"
  ],
  "diagnostics": []
}
```

## Recovery retry cap

`MAX_REMEDIATION_RETRIES` is two. Failed recovery checks increment
`retryCount`; failures one and two return to `remediation`, while failure three
moves the incident to `blocked`. Invalid negative or fractional overrides are
rejected.

This prototype does not yet add custom OTel hook telemetry. OpenClaw's built-in
telemetry/export path remains the intended observability seam; Guardian-specific
policy counters can be added after the enforcement behavior is stable.
