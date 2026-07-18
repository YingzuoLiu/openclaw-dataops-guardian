# Proof 3: Lobster approval recovery

Status: **passed** on 2026-07-18 with `openclaw@2026.6.9` and
`@openclaw/lobster@2026.6.9`.

The fixture `workflows/proof3-approval.lobster` has three deterministic steps:
prepare, approve, and apply. A marker counts executions of the prepare and apply
steps.

The proof performed this lifecycle:

1. run the workflow through the Gateway `lobster` tool;
2. receive `needs_approval` and a resume token;
3. observe `prepareCount=1` and `applyCount=0`;
4. stop and restart the Gateway;
5. resume with the token and approve;
6. observe completion with `prepareCount=1` and `applyCount=1`.

Observed results:

```text
{"command":"run","ok":true,"status":"needs_approval","prepareCount":1,"applyCount":0}
{"command":"resume","ok":true,"status":"ok","prepareCount":1,"applyCount":1}
```

The unchanged prepare count proves that approval recovery did not rerun the
already completed investigation step, including across a Gateway restart.

## Integration boundary

Lobster owns only the deterministic back half of Guardian workflows: approval,
remediation execution, and recovery checks. Dynamic evidence collection remains
normal OpenClaw tool orchestration. Embedded Lobster does not reliably inherit
Gateway authentication for nested `openclaw.invoke`, so the design does not use
Lobster as a wrapper around every investigation tool.

Lobster is a separate npm plugin, not part of the core `openclaw` package. The
spike pins both packages to 2026.6.9 and enables the optional tool additively
with `tools.alsoAllow: ["lobster"]`.
