# Proof 2: session extension compatibility

Status: **passed** on 2026-07-18 with `openclaw@2026.6.9` and Node.js 24.14.0.

## What was proved

The live Gateway test used the plugin registration in `src/index.ts` and the
RPC fixture in `scripts/proof2-rpc.mjs` to verify this lifecycle:

1. create an isolated session with `sessions.create`;
2. persist incident JSON with `sessions.pluginPatch`;
3. observe the registered projection with `sessions.describe`;
4. stop and restart the Gateway;
5. observe the identical projection after restart;
6. call `sessions.reset` and observe that the projection is absent.

Observed fixture results:

```text
{"command":"write","ok":true,"projectionPresent":true}
{"command":"read","ok":true,"projectionPresent":true}
{"command":"reset","ok":true,"projectionPresent":false}
```

The raw OpenClaw session store also contained the state under
`pluginExtensions["dataops-guardian"]["incident"]` between the write and reset.

## Compatibility findings

- `sessions.pluginPatch` requires an existing session. The fixture calls
  `sessions.create` first; plugin patching does not create the session itself.
- In OpenClaw 2026.6.9, the asynchronous `sessions.list` path emits lightweight
  rows and skips plugin extension projection. Use `sessions.describe` when the
  projected extension value is required. A list-based UI should fetch the full
  row only for the selected session.
- `sessions.pluginPatch` requires the `operator.admin` Gateway scope.
- The compatibility floor remains `>=2026.6.9`; the package is pinned exactly to
  2026.6.9 until the spike is repeated against a later stable release.

## Test isolation and security

The proof ran a loopback-only Gateway with a disposable `OPENCLAW_STATE_DIR`.
Because a clean CLI profile cannot approve its own `operator.admin` scope
upgrade, the fixture temporarily set
`gateway.controlUi.dangerouslyDisableDeviceAuth=true` and connected as the
official TUI client type without a device identity. The setting was removed
immediately after the proof.

This bypass is a test harness detail. It must not be committed to a normal or
production OpenClaw configuration.

## Result

The recent session-extension persistence risk is retired for the pinned
version. Proof 1 (tool loading) can now proceed without building on an unverified
state mechanism.
