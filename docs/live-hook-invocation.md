# Live hook invocation proof

Status: **passed** locally on 2026-07-18 with `openclaw@2026.6.9`.

This proof closes the gap between "the plugin loader registered the hooks" and
"the real Gateway Agent response path invoked them." It does not use a paid
model. A loopback-only OpenAI-compatible scripted model always returns a direct
operational conclusion without calling a Tool.

## Expected path

```text
Gateway agent RPC
  -> before_agent_run activates require_tools
  -> scripted model answers without a Tool
  -> before_agent_finalize requests revise
  -> scripted model answers without a Tool again
  -> bounded retry budget is exhausted
  -> agent.wait completes
```

The proof asserts all of the following:

- the Gateway accepts and completes a real `agent` / `agent.wait` run;
- the audit log contains `before_agent_run` with `decision=activate`;
- the audit log contains `before_agent_finalize` with `decision=revise`;
- the scripted model receives exactly two completion requests: the initial
  pass and one revision pass;
- the model server is loopback-only and reports zero API cost.

Run it with:

```bash
npm run hooks:live-proof
```

The isolated default state directory is `.openclaw-live-hook-proof`. The final
summary is written to `live-hook-proof.json`; raw Gateway logs, extracted hook
audit lines, model-request metadata, and the Agent RPC result remain beside it.
Prompt text, model output, credentials, and Tool payloads are not copied into
the structured request log.

## Observed result

The clean proof run produced:

```json
{
  "ok": true,
  "gatewayAgentRun": true,
  "hookActivationObserved": true,
  "finalizeRevisionObserved": true,
  "modelCalls": 2,
  "expectedModelCalls": 2,
  "apiCostUsd": 0
}
```

The raw Gateway log also included OpenClaw's own message that
`before_agent_finalize` requested one more pass. This is independent evidence
that the host consumed the hook result rather than merely invoking the
callback.

## `2026.6.9` run-context finding

The first live attempt found that the pinned linked-plugin runtime can invoke
`before_agent_run` while rejecting `api.runContext.setRunContext`. The previous
fail-closed behavior therefore blocked the run before any model call. Guardian
now uses the host run context when accepted and otherwise stores the active
ledger in a bounded process-local map keyed by run id. `agent_end` clears both
stores.

This fallback does not replace durable session-extension state. It is used
only for an active run's Tool-name ledger; incident evidence, approval state,
and workflow transitions remain in the native durable extension and Reducer.

## Safety of the fixture

The proof uses `gateway.controlUi.dangerouslyDisableDeviceAuth=true` only in its
isolated test profile so the local RPC fixture can connect without a paired
device. The cleanup trap unsets the flag. Do not copy that setting into a
normal or production profile.

The fixture does not prove model behavior under realistic prompt pressure.
That is the next A/B evaluation. It proves only the runtime wiring needed
before spending OpenRouter credit.
