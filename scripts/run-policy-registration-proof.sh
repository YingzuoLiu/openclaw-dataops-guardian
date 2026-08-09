#!/usr/bin/env bash
set -euo pipefail

PROOF_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$PROOF_SCRIPT_DIR/guardian-proof-build.sh"

export OPENCLAW_STATE_DIR="${OPENCLAW_STATE_DIR:-$PWD/.openclaw-policy-proof}"

guardian_build_or_verify_prebuilt
if [[ -n "${GUARDIAN_PROOF_PLUGIN_DIR:-}" ]]; then
  POLICY_BATCH_JSON="$(
    node -e '
      const pluginDir = process.argv[1];
      process.stdout.write(JSON.stringify([
        { path: "plugins.load.paths", value: [pluginDir] },
        { path: "plugins.entries.dataops-guardian.enabled", value: true },
        { path: "plugins.entries.dataops-guardian.hooks.allowConversationAccess", value: true },
        { path: "plugins.entries.dataops-guardian.config.enforceRequireToolsOnAgentRuns", value: true },
      ]));
    ' \
      "$GUARDIAN_PROOF_PLUGIN_DIR"
  )"
else
  ./node_modules/.bin/openclaw plugins install --link "$PWD" >/dev/null
  POLICY_BATCH_JSON='[
    {"path":"plugins.entries.dataops-guardian.enabled","value":true},
    {"path":"plugins.entries.dataops-guardian.hooks.allowConversationAccess","value":true},
    {"path":"plugins.entries.dataops-guardian.config.enforceRequireToolsOnAgentRuns","value":true}
  ]'
fi
printf '[policy] configure\n' >&2
./node_modules/.bin/openclaw config set \
  --batch-json "$POLICY_BATCH_JSON" >/dev/null
printf '[policy] inspect\n' >&2
./node_modules/.bin/openclaw plugins inspect \
  dataops-guardian --runtime --json >"$OPENCLAW_STATE_DIR/policy-inspect.json"

node --input-type=module - "$OPENCLAW_STATE_DIR/policy-inspect.json" <<'NODE'
import { readFile } from "node:fs/promises";

const inspection = JSON.parse(await readFile(process.argv[2], "utf8"));
const expected = new Set([
  "agent_end",
  "before_tool_call",
  "after_tool_call",
  "before_agent_run",
  "before_agent_finalize",
]);
const actual = new Set(
  (inspection.typedHooks ?? []).map((entry) => entry.name),
);
const missing = [...expected].filter((name) => !actual.has(name));

if (missing.length > 0 || (inspection.diagnostics ?? []).length > 0) {
  throw new Error(
    `policy hook registration failed: ${JSON.stringify({
      missing,
      diagnostics: inspection.diagnostics,
    })}`,
  );
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    hookCount: inspection.plugin?.hookCount,
    typedHooks: [...actual].sort(),
    diagnostics: inspection.diagnostics,
  })}\n`,
);
NODE
