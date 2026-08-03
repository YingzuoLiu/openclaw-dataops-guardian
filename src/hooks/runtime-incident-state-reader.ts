import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

const GUARDIAN_PLUGIN_ID = "dataops-guardian";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Reads a persisted plugin session extension via
 * `api.runtime.agent.session.getSessionEntry`, confirmed by repro (not just
 * source inspection) to correctly observe an immediately preceding
 * `sessions.pluginPatch` write for the same session -- unlike
 * `ctx.getSessionExtension` inside `before_tool_call`, which returns
 * `null`/`undefined` for that same write on every published OpenClaw
 * release tested (2026.6.9 through 2026.7.2-beta.7). Gateway session state
 * remains the sole durable copy of `IncidentState`; this only changes which
 * accessor reads it inside the hook.
 *
 * `runtime` is accepted as `unknown` and walked defensively rather than
 * typed against `PluginRuntimeCore` directly: this is a semi-internal host
 * surface the plugin doesn't own the exact shape of, and the whole point of
 * this reader is to fail closed rather than trust an assumed shape.
 *
 * Fails closed (returns `undefined`) on anything short of a fully resolved
 * value -- missing `sessionKey`, a runtime without a callable
 * `agent.session.getSessionEntry`, a thrown error, a non-object return, a
 * missing session entry, or a missing plugin/namespace slot -- so callers
 * can treat `undefined` exactly like `ctx.getSessionExtension`'s existing
 * "no persisted state" case. Never throws.
 */
export function readRuntimeIncidentState(
  runtime: unknown,
  sessionKey: string | undefined,
  namespace: string,
): PluginJsonValue | undefined {
  if (!sessionKey) {
    return undefined;
  }
  if (!isRecord(runtime)) {
    return undefined;
  }
  const agent = runtime.agent;
  if (!isRecord(agent)) {
    return undefined;
  }
  const session = agent.session;
  if (!isRecord(session)) {
    return undefined;
  }
  const getSessionEntry = session.getSessionEntry;
  if (typeof getSessionEntry !== "function") {
    return undefined;
  }

  let entry: unknown;
  try {
    entry = getSessionEntry({ sessionKey });
  } catch {
    return undefined;
  }
  if (!isRecord(entry)) {
    return undefined;
  }
  const pluginExtensions = entry.pluginExtensions;
  if (!isRecord(pluginExtensions)) {
    return undefined;
  }
  const guardianExtensions = pluginExtensions[GUARDIAN_PLUGIN_ID];
  if (!isRecord(guardianExtensions)) {
    return undefined;
  }
  return guardianExtensions[namespace] as PluginJsonValue | undefined;
}
