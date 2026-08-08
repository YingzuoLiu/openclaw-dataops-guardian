import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createIncidentOccurrenceId,
  type IncidentState,
} from "../../state/incident-state.js";
import {
  GatewayIncidentClient,
  GatewayPersistenceError,
} from "./gateway-incident-client.js";

type MockGatewayOptions = {
  onHelloOk?: () => void;
  onConnectError?: (error: Error) => void;
};

const gatewayMock = vi.hoisted(() => ({
  options: undefined as MockGatewayOptions | undefined,
  request: vi.fn(),
  start: vi.fn(),
  stopAndWait: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: class {
    constructor(options: MockGatewayOptions) {
      gatewayMock.options = options;
    }

    start(): void {
      gatewayMock.start();
    }

    async stopAndWait(options: unknown): Promise<void> {
      await gatewayMock.stopAndWait(options);
    }

    async request<T>(method: string, params: unknown): Promise<T> {
      return (await gatewayMock.request(method, params)) as T;
    }
  },
}));

const startsAt = "2026-08-08T00:00:00.000Z";

function incidentState(): IncidentState {
  return {
    schemaVersion: 3,
    alertId: "PaymentSuccessRateLow",
    fingerprint: "fingerprint-1",
    occurrenceId: createIncidentOccurrenceId("fingerprint-1", startsAt),
    alertStatus: "firing",
    startsAt,
    endsAt: null,
    lastReceivedAt: startsAt,
    deliveryCount: 1,
    nonDuplicateDeliveryCount: 1,
    recentDeliveryIds: ["delivery-1"],
    stage: "alert_received",
    evidence: [],
    proposedAction: null,
    approvalStatus: "not_requested",
    remediationAttempts: [],
    evidenceValidation: {
      status: "not_checked",
      checkedAt: null,
      issues: [],
    },
    updatedAt: startsAt,
  };
}

function newClient(connectTimeoutMs = 1_000): GatewayIncidentClient {
  return new GatewayIncidentClient({
    url: "ws://127.0.0.1:18789",
    token: "test-token",
    clientDisplayName: "test-bridge",
    requestTimeoutMs: 500,
    connectTimeoutMs,
  });
}

async function connect(client: GatewayIncidentClient): Promise<void> {
  const connecting = client.connect();
  gatewayMock.options?.onHelloOk?.();
  await connecting;
}

describe("GatewayIncidentClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    gatewayMock.options = undefined;
    gatewayMock.request.mockReset();
    gatewayMock.start.mockReset();
    gatewayMock.stopAndWait.mockReset();
    gatewayMock.stopAndWait.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("accepts a semantically equal persistence echo with reordered object keys", async () => {
    const client = newClient();
    await connect(client);
    const state = incidentState();
    const reorderedEvidenceValidation = {
      issues: state.evidenceValidation.issues,
      checkedAt: state.evidenceValidation.checkedAt,
      status: state.evidenceValidation.status,
    };
    const reorderedEcho = Object.fromEntries(
      Object.entries({
        ...state,
        evidenceValidation: reorderedEvidenceValidation,
      }).reverse(),
    ) as PluginJsonValue;
    expect(JSON.stringify(reorderedEcho)).not.toBe(JSON.stringify(state));
    gatewayMock.request
      .mockResolvedValueOnce({ session: {} })
      .mockResolvedValueOnce({ value: reorderedEcho });

    await expect(
      client.persistIncidentState("agent:main:incident-1", state),
    ).resolves.toBeUndefined();
  });

  it("rejects a persistence echo whose value actually changed", async () => {
    const client = newClient();
    await connect(client);
    const state = incidentState();
    gatewayMock.request
      .mockResolvedValueOnce({ session: {} })
      .mockResolvedValueOnce({
        value: { ...state, deliveryCount: state.deliveryCount + 1 },
      });

    await expect(
      client.persistIncidentState("agent:main:incident-1", state),
    ).rejects.toBeInstanceOf(GatewayPersistenceError);
  });

  it("clears the connect timeout after a successful hello", async () => {
    const client = newClient();
    const connecting = client.connect();
    expect(vi.getTimerCount()).toBe(1);

    gatewayMock.options?.onHelloOk?.();
    await expect(connecting).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the connect timeout while preserving a connection error", async () => {
    const client = newClient();
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow("gateway unavailable");

    gatewayMock.options?.onConnectError?.(new Error("gateway unavailable"));
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on timeout and remains settled after a late hello", async () => {
    const client = newClient(1_000);
    const connecting = client.connect();
    const rejected = expect(connecting).rejects.toThrow(
      "gateway connect timeout",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    gatewayMock.options?.onHelloOk?.();
    await expect(connecting).rejects.toThrow("gateway connect timeout");
  });
});
