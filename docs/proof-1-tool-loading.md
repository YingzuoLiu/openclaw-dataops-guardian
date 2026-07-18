# Proof 1: tool loading and invocation

Status: **passed** on 2026-07-18 with `openclaw@2026.6.9`.

The proof registers the read-only `guardian_inspect_metric_snapshot` tool,
discovers it through `tools.catalog`, and invokes it through `tools.invoke`.

Observed result:

```text
{"ok":true,"catalogLoaded":true,"invoked":true,"toolName":"guardian_inspect_metric_snapshot","classification":"critical"}
```

The first live attempt correctly failed because the TypeScript registration was
not enough: OpenClaw requires every agent tool to also be declared under
`contracts.tools` in `openclaw.plugin.json`. After adding that manifest
contract, the tool appeared in the plugin catalog and executed successfully.

This proves the intended `src/tools/` loading path without coupling the tool to
session persistence or Lobster orchestration.
