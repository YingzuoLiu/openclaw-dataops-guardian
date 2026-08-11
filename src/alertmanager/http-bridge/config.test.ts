import { describe, expect, it } from "vitest";

import { loadBridgeConfigFromEnv } from "./config.js";

function requiredEnv(): NodeJS.ProcessEnv {
  return {
    ALERTMANAGER_BRIDGE_TOKEN: "alert-token",
    OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
    OPENCLAW_GATEWAY_TOKEN: "gateway-token",
    ALERTMANAGER_BRIDGE_STATE_DIR: "/var/lib/dataops-guardian/bridge",
  };
}

describe("loadBridgeConfigFromEnv", () => {
  it("loads the bounded container defaults", () => {
    expect(loadBridgeConfigFromEnv(requiredEnv())).toMatchObject({
      host: "127.0.0.1",
      port: 9187,
      gatewayRequestTimeoutMs: 10_000,
      gatewayConnectTimeoutMs: 15_000,
    });
  });

  it.each([
    "0",
    "-1",
    "10s",
    "9187junk",
    "1.5",
    " 9187",
    "9187 ",
    "9007199254740992",
  ])("rejects a non-canonical port value %j", (value) => {
    expect(() =>
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        ALERTMANAGER_BRIDGE_PORT: value,
      }),
    ).toThrow(/ALERTMANAGER_BRIDGE_PORT/);
  });

  it.each([
    "http://127.0.0.1:18789",
    "ws://gateway.example.test:18789",
    "ws://localhost:18789",
    "ws://user:password@127.0.0.1:18789",
    "ws://127.0.0.1:18789/gateway",
    "not-a-url",
  ])("rejects a non-local backend Gateway URL %j", (value) => {
    expect(() =>
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        OPENCLAW_GATEWAY_URL: value,
      }),
    ).toThrow(/OPENCLAW_GATEWAY_URL/);
  });

  it("accepts IPv6 loopback for a colocated Gateway", () => {
    expect(
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        OPENCLAW_GATEWAY_URL: "wss://[::1]:18789",
      }).gatewayUrl,
    ).toBe("wss://[::1]:18789");
  });

  it("requires distinct webhook and Gateway credentials", () => {
    expect(() =>
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        ALERTMANAGER_BRIDGE_TOKEN: "reused-token",
        OPENCLAW_GATEWAY_TOKEN: "reused-token",
      }),
    ).toThrow("must be distinct");
  });

  it("requires an absolute durable state directory", () => {
    expect(() =>
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        ALERTMANAGER_BRIDGE_STATE_DIR: "relative-state",
      }),
    ).toThrow("must be an absolute path");
  });

  it("rejects a port above 65535", () => {
    expect(() =>
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        ALERTMANAGER_BRIDGE_PORT: "65536",
      }),
    ).toThrow("between 1 and 65535");
  });

  it("accepts the highest valid TCP port", () => {
    expect(
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        ALERTMANAGER_BRIDGE_PORT: "65535",
      }).port,
    ).toBe(65_535);
  });

  it.each([
    "10ms",
    "1.5",
    "0",
    "2147483648",
  ])("rejects an invalid request timeout %j", (value) => {
    expect(() =>
      loadBridgeConfigFromEnv({
        ...requiredEnv(),
        ALERTMANAGER_BRIDGE_GATEWAY_REQUEST_TIMEOUT_MS: value,
      }),
    ).toThrow(/ALERTMANAGER_BRIDGE_GATEWAY_REQUEST_TIMEOUT_MS/);
  });
});
