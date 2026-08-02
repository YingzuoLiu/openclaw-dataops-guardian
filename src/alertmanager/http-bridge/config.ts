/**
 * Fixed request body cap, enforced while streaming so an oversized body is
 * rejected before it is ever fully buffered. Not operator-configurable by
 * design: a fixed bound is part of the bridge's DoS posture, not a tuning
 * knob per deployment.
 */
export const MAX_REQUEST_BODY_BYTES = 1_048_576;

export const ALERTMANAGER_WEBHOOK_PATH = "/v1/alertmanager/webhook";

export type BridgeConfig = {
  host: string;
  port: number;
  bearerToken: string;
  gatewayUrl: string;
  gatewayToken: string;
  stateDir: string;
  gatewayRequestTimeoutMs: number;
  gatewayConnectTimeoutMs: number;
};

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

/**
 * Loads bridge configuration from environment variables. Binds to
 * `127.0.0.1` unless `ALERTMANAGER_BRIDGE_HOST` explicitly overrides it —
 * exposing the receiver beyond loopback is an operator decision, never the
 * default.
 */
export function loadBridgeConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  return {
    host: env.ALERTMANAGER_BRIDGE_HOST?.trim() || "127.0.0.1",
    port: optionalPositiveInt(env, "ALERTMANAGER_BRIDGE_PORT", 9187),
    bearerToken: requireEnv(env, "ALERTMANAGER_BRIDGE_TOKEN"),
    gatewayUrl: requireEnv(env, "OPENCLAW_GATEWAY_URL"),
    gatewayToken: requireEnv(env, "OPENCLAW_GATEWAY_TOKEN"),
    stateDir: requireEnv(env, "ALERTMANAGER_BRIDGE_STATE_DIR"),
    gatewayRequestTimeoutMs: optionalPositiveInt(
      env,
      "ALERTMANAGER_BRIDGE_GATEWAY_REQUEST_TIMEOUT_MS",
      10_000,
    ),
    gatewayConnectTimeoutMs: optionalPositiveInt(
      env,
      "ALERTMANAGER_BRIDGE_GATEWAY_CONNECT_TIMEOUT_MS",
      15_000,
    ),
  };
}
