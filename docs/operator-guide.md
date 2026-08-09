# Operator guide

DataOps Guardian `v0.2.0` is a compatibility-first OpenClaw plugin prototype.
It provides read-only Prometheus evidence collection, deterministic metric
inspection, durable incident state, remediation proposals, an allowlisted
Kubernetes rollback, dual recovery verification, and bounded Agent evidence
gates. It is not approved for production or unattended remediation.

## Prerequisites

- Node.js `22.22.2+` on the Node 22 line, `24.15.0+` on Node 24, or Node 26+;
- OpenClaw `>=2026.6.34`;
- a dedicated OpenClaw profile for Guardian Agent runs;
- a Prometheus-compatible instant-query endpoint reachable by the Gateway.

Guardian `v0.2.0` does not implement bearer-token, mTLS, or managed-Prometheus
authentication. Do not put credentials in a URL. For a non-public Prometheus
deployment, use a network-restricted endpoint or a trusted local proxy that
owns authentication.

## Install from a source checkout

Guardian is not published to npm or ClawHub. Pin the source tag, install its
dependencies, build it, and link the checkout into OpenClaw:

```bash
git clone --branch v0.2.0 --depth 1 \
  https://github.com/YingzuoLiu/openclaw-dataops-guardian.git
cd openclaw-dataops-guardian
npm ci
npm run build
openclaw plugins install --link "$PWD"
openclaw plugins enable dataops-guardian
```

PowerShell uses the same flow with the current directory resolved explicitly:

```powershell
git clone --branch v0.2.0 --depth 1 `
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

This baseline installation is intentionally read-only. The standalone
Alertmanager HTTP bridge is a separate operator process and is not started by
installing or enabling the plugin. Kubernetes mutation is disabled unless an
administrator separately supplies a cluster identity, scoped kubeconfig, and
exact namespace/Deployment allowlist. Do not add that configuration to a
general-purpose profile merely to try the project.

For the complete integration proof, use `npm run demo`: it creates its own
disposable kind cluster, exact allowlist, short-lived scoped credential, and
loopback bridge, then removes them. The component contracts document the
[bridge configuration](alertmanager-http-bridge.md) and
[rollback authority](kubernetes-deployment-rollback.md) without making either
part of the safe baseline install.

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
- `guardian_propose_remediation`;
- `guardian_rollback_deployment`;
- `guardian_verify_deployment_recovery`.

With conversation access enabled, it should also expose five typed hooks:

- `before_agent_run`;
- `before_tool_call`;
- `after_tool_call`;
- `before_agent_finalize`;
- `agent_end`.

Run deterministic local verification from the checkout:

```bash
npm run check
npm run demo:fast
```

The fast demo aggregates policy registration, a live Agent finalize gate, the
HTTP bridge and crash-window checks, and synthetic approve/deny paths. It uses
isolated OpenClaw state directories and loopback-only fixtures, with no Docker,
cluster, paid API, or external model. Proof clients temporarily disable device
authentication only inside their disposable local profiles and restore it on
exit. The runner explicitly loads Guardian and Lobster while disabling discovery
of unrelated bundled extensions, so a WSL checkout under `/mnt/c` does not fail
on DrvFS world-writable modes. It also clears inherited `OPENCLAW_CONFIG_PATH`,
`OPENCLAW_PROFILE`, and `OPENCLAW_HOME` overrides before assigning its
proof-owned state directory, so an exported caller profile cannot redirect the
run into normal OpenClaw state. Never point a proof script at a normal Gateway
profile.

To run the full release proof on Linux/WSL with a reachable Docker daemon,
`kind`, and `kubectl`:

```bash
npm run demo
```

While running, it emits phase names only and applies component deadlines when
the standard Linux `timeout` command is available. On success, it emits only an
allowlisted JSON summary after cleanup. On failure, it emits a bounded tail of
the active local proof log before cleanup. See the [final safety
proof](final-safety-proof.md) for the complete positive and negative matrix.

## Safety model

- Investigation PromQL may be Agent-supplied, but the Agent cannot choose the
  Prometheus base URL. Recovery PromQL, comparator, threshold, and maximum
  sample age are administrator-owned on the exact allowlist entry.
- Prometheus queries must return exactly one finite instant-vector sample.
- Failed Tools do not satisfy the run evidence ledger.
- A remediation proposal is blocked until both required evidence Tools succeed.
- Durable incident state refuses an unsupported transition into approval.
- `before_agent_finalize` requests at most one revision; it is not a permanent
  message-delivery veto.
- Recovery requires both audited Deployment readiness and a fresh
  post-remediation Prometheus sample. An Alertmanager resolved event is not
  proof.
- Recovery may retry remediation twice; the third unhealthy check moves the
  incident to `blocked`.
- Real mutation remains limited to the administrator-allowlisted Deployment
  rollback. The repository proof targets only a disposable kind cluster.

See [the evidence-gate contract](evidence-gates.md),
[Prometheus adapter contract](prometheus-adapter.md), and
[Step 4 recovery contract](deployment-prometheus-recovery.md) for the component
invariants, and [the Step 5 final proof](final-safety-proof.md) for their
end-to-end composition.

## Logs and troubleshooting

Guardian emits sanitized JSON audit events for run activation and finalize
decisions. They contain run identifiers, decisions, timestamps, and required or
missing Tool names; they do not include prompts, Tool payloads, or credentials.

Common failures:

| Symptom | Check |
| --- | --- |
| Conversation hooks have loader diagnostics | Set `hooks.allowConversationAccess=true`, restart, and inspect the live runtime again. |
| Prometheus query reports missing configuration | Set `prometheusBaseUrl` in plugin config; the Agent cannot provide it. |
| Prometheus rejects authentication | `v0.2.0` has no credential provider; use a trusted proxy instead of credentials in the URL. |
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
