import { isAbsolute } from "node:path";

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

function requireLoopbackGatewayUrl(env: NodeJS.ProcessEnv): string {
  const value = requireEnv(env, "OPENCLAW_GATEWAY_URL");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(
      "OPENCLAW_GATEWAY_URL must be a valid loopback ws:// or wss:// URL",
      { cause: error },
    );
  }
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error("OPENCLAW_GATEWAY_URL must use ws:// or wss://");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("OPENCLAW_GATEWAY_URL must not embed credentials");
  }
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
    throw new Error(
      "OPENCLAW_GATEWAY_URL must target 127.0.0.1 or [::1] for the local backend protocol",
    );
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
    throw new Error("OPENCLAW_GATEWAY_URL must not include a path, query, or fragment");
  }
  return value;
}

function requireAbsoluteStateDir(env: NodeJS.ProcessEnv): string {
  const value = requireEnv(env, "ALERTMANAGER_BRIDGE_STATE_DIR").trim();
  if (!isAbsolute(value)) {
    throw new Error("ALERTMANAGER_BRIDGE_STATE_DIR must be an absolute path");
  }
  return value;
}

function optionalPositiveInt(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const raw = env[name];
  if (raw === undefined) {
    return fallback;
  }
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
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
  const bearerToken = requireEnv(env, "ALERTMANAGER_BRIDGE_TOKEN");
  const gatewayToken = requireEnv(env, "OPENCLAW_GATEWAY_TOKEN");
  if (bearerToken === gatewayToken) {
    throw new Error(
      "ALERTMANAGER_BRIDGE_TOKEN and OPENCLAW_GATEWAY_TOKEN must be distinct",
    );
  }
  return {
    host: env.ALERTMANAGER_BRIDGE_HOST?.trim() || "127.0.0.1",
    port: optionalPositiveInt(env, "ALERTMANAGER_BRIDGE_PORT", 9187, 65_535),
    bearerToken,
    gatewayUrl: requireLoopbackGatewayUrl(env),
    gatewayToken,
    stateDir: requireAbsoluteStateDir(env),
    gatewayRequestTimeoutMs: optionalPositiveInt(
      env,
      "ALERTMANAGER_BRIDGE_GATEWAY_REQUEST_TIMEOUT_MS",
      10_000,
      2_147_483_647,
    ),
    gatewayConnectTimeoutMs: optionalPositiveInt(
      env,
      "ALERTMANAGER_BRIDGE_GATEWAY_CONNECT_TIMEOUT_MS",
      15_000,
      2_147_483_647,
    ),
  };
}
