# Operator guide

DataOps Guardian `v0.1.0` is a compatibility-first OpenClaw plugin prototype.
It provides read-only Prometheus evidence collection, deterministic metric
inspection, durable incident state, remediation proposals, and bounded Agent
evidence gates. It does not execute a production rollback.

## Prerequisites

- Node.js `>=22.19.0`;
- OpenClaw `>=2026.6.9`;
- a dedicated OpenClaw profile for Guardian Agent runs;
- a Prometheus-compatible instant-query endpoint reachable by the Gateway.

Guardian `v0.1.0` does not implement bearer-token, mTLS, or managed-Prometheus
authentication. Do not put credentials in a URL. For a non-public Prometheus
deployment, use a network-restricted endpoint or a trusted local proxy that
owns authentication.

## Install from a source checkout

Guardian is not published to npm or ClawHub. Pin the source tag, install its
dependencies, build it, and link the checkout into OpenClaw:

```bash
git clone --branch v0.1.0 --depth 1 \
  https://github.com/YingzuoLiu/openclaw-dataops-guardian.git
cd openclaw-dataops-guardian
npm ci
npm run build
openclaw plugins install --link "$PWD"
openclaw plugins enable dataops-guardian
```

PowerShell uses the same flow with the current directory resolved explicitly:

```powershell
git clone --branch v0.1.0 --depth 1 `
  https://github.com/YingzuoLiu/openclaw-dataops-guardian.git
Set-Location openclaw-dataops-guardian
npm ci
npm run build
openclaw plugins install --link (Get-Location).Path
openclaw plugins enable dataops-guardian
```

Treat a plugin install as code execution. Review the pinned tag before loading
it into a Gateway.

## Configure a dedicated Guardian profile

Set the administrator-owned Prometheus endpoint and timeout:

```bash
openclaw config set \
  plugins.entries.dataops-guardian.config.prometheusBaseUrl \
  https://prometheus.example.com
openclaw config set \
  plugins.entries.dataops-guardian.config.prometheusTimeoutMs \
  5000
```

Non-bundled plugins require explicit consent before conversation hooks can
observe an Agent run:

```bash
openclaw config set \
  plugins.entries.dataops-guardian.hooks.allowConversationAccess \
  true
```

For a dedicated Guardian Agent profile, activate the zero-Tool response gate:

```bash
openclaw config set \
  plugins.entries.dataops-guardian.config.requireToolsGateMode \
  all_agent_runs
```

Do not enable `all_agent_runs` in a general-purpose profile: the plugin is
loaded globally and would require Guardian evidence Tools in unrelated Agent
runs. The default `on_guardian_tool` mode activates only after a run touches a
`guardian_*` Tool. The `disabled` mode exists solely for controlled A/B
evaluation and must not be used to weaken a normal Guardian profile.

Restart an unmanaged Gateway after install or configuration changes:

```bash
openclaw gateway restart
```

## Verify the live runtime

Inspect the running Gateway rather than relying only on the cold manifest:

```bash
openclaw plugins inspect dataops-guardian --runtime --json
```

The inspection should have no diagnostics and should expose these Tools:

- `guardian_query_prometheus`;
- `guardian_inspect_metric_snapshot`;
- `guardian_propose_remediation`.

With conversation access enabled, it should also expose five typed hooks:

- `before_agent_run`;
- `before_tool_call`;
- `after_tool_call`;
- `before_agent_finalize`;
- `agent_end`.

Run deterministic local verification from the checkout:

```bash
npm run check
npm run policy:proof
npm run hooks:live-proof
npm run slice:proof
```

The proof scripts create isolated OpenClaw state directories and loopback-only
fixtures. They temporarily disable device authentication for their own local
RPC clients and restore it on exit. Never point a proof script at a normal
Gateway profile.

## Safety model

- The Agent supplies PromQL but cannot choose the Prometheus base URL.
- Prometheus queries must return exactly one finite instant-vector sample.
- Failed Tools do not satisfy the run evidence ledger.
- A remediation proposal is blocked until both required evidence Tools succeed.
- Durable incident state refuses an unsupported transition into approval.
- `before_agent_finalize` requests at most one revision; it is not a permanent
  message-delivery veto.
- Recovery may retry remediation twice; the third unhealthy check moves the
  incident to `blocked`.
- The included Lobster remediation and recovery steps are synthetic and set
  `mutatesProduction: false`.

See [the evidence-gate contract](evidence-gates.md),
[Prometheus adapter contract](prometheus-adapter.md), and
[first vertical slice](vertical-slice.md) for the exact invariants.

## Logs and troubleshooting

Guardian emits sanitized JSON audit events for run activation and finalize
decisions. They contain run identifiers, decisions, timestamps, and required or
missing Tool names; they do not include prompts, Tool payloads, or credentials.

Common failures:

| Symptom | Check |
| --- | --- |
| Conversation hooks have loader diagnostics | Set `hooks.allowConversationAccess=true`, restart, and inspect the live runtime again. |
| Prometheus query reports missing configuration | Set `prometheusBaseUrl` in plugin config; the Agent cannot provide it. |
| Prometheus rejects authentication | `v0.1.0` has no credential provider; use a trusted proxy instead of credentials in the URL. |
| Proposal Tool is blocked | Confirm both query and inspection Tools succeeded in the same Agent run. |
| Log warns about a rejected run-context write | Guardian is using its bounded process-local fallback for the active run; durable incident state is unaffected. |

## Disable or remove

Disable the plugin without deleting its installed files:

```bash
openclaw plugins disable dataops-guardian
openclaw gateway restart
```

Remove the linked install when it is no longer needed:

```bash
openclaw plugins uninstall dataops-guardian
```

Resetting an OpenClaw session clears Guardian's session-extension incident
state for that session. Export any evidence needed for an audit before reset.
