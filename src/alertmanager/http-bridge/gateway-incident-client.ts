import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";

import { INCIDENT_STATE_NAMESPACE } from "../../state/incident-state.js";
import type { IncidentState } from "../../state/incident-state.js";

export const GUARDIAN_PLUGIN_ID = "dataops-guardian";
export const BRIDGE_AGENT_ID = "main";

export function incidentSessionKey(occurrenceId: string): string {
  return `agent:${BRIDGE_AGENT_ID}:dataops-guardian-incident-${occurrenceId}`;
}

export type GatewayIncidentClientOptions = {
  url: string;
  token: string;
  clientDisplayName: string;
  requestTimeoutMs: number;
  connectTimeoutMs: number;
};

/**
 * Thrown for any failure to reach or persist through the Gateway. Callers
 * map this to an HTTP 503 without acknowledging the webhook, so
 * Alertmanager retries and no delivery is silently dropped.
 */
export class GatewayPersistenceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GatewayPersistenceError";
  }
}

function deepEqualJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

type SessionsDescribeResult = {
  session: {
    pluginExtensions?: Array<{
      pluginId: string;
      namespace: string;
      value: PluginJsonValue;
    }>;
  } | null;
};

/**
 * Wraps the Gateway RPCs the bridge needs (`sessions.create`,
 * `sessions.describe`, `sessions.pluginPatch`) behind an interface scoped to
 * IncidentState v3. The Gateway session itself remains the only durable copy
 * of `IncidentState`; nothing here caches decoded state across calls.
 */
export class GatewayIncidentClient {
  private readonly client: GatewayClient;
  private ready: Promise<void>;

  constructor(options: GatewayIncidentClientOptions) {
    let resolveReady: () => void;
    let rejectReady: (error: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    this.client = new GatewayClient({
      url: options.url,
      token: options.token,
      clientName: "gateway-client",
      clientDisplayName: options.clientDisplayName,
      clientVersion: "2026.6.9",
      platform: process.platform,
      mode: "backend",
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      deviceIdentity: null,
      requestTimeoutMs: options.requestTimeoutMs,
      onHelloOk: () => resolveReady(),
      onConnectError: (error) => rejectReady(error),
    });

    const connectTimeoutMs = options.connectTimeoutMs;
    this.ready = Promise.race([
      this.ready,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("gateway connect timeout")),
          connectTimeoutMs,
        ),
      ),
    ]);
  }

  async connect(): Promise<void> {
    this.client.start();
    await this.ready;
  }

  async close(): Promise<void> {
    await this.client.stopAndWait({ timeoutMs: 2_000 });
  }

  private async request<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.client.request<T>(method, params);
    } catch (error) {
      // The underlying cause (a connect timeout, a dropped socket mid
      // reconnect backoff, an RPC-level rejection, ...) is folded into the
      // message here because that message is what ends up in the durable
      // `persistence_failure` audit record (`audit.ts`/`server.ts`) — never
      // in the HTTP response, which only ever exposes the sanitized
      // `persistence_unavailable` error code. Without it, every kind of
      // Gateway failure looks identical in the audit trail.
      const causeMessage = error instanceof Error ? error.message : String(error);
      throw new GatewayPersistenceError(
        `gateway request failed: ${method}: ${causeMessage}`,
        { cause: error },
      );
    }
  }

  /**
   * Returns the decoded `IncidentState` plugin value for `sessionKey`, or
   * `undefined` when the session does not exist or carries no incident
   * extension value yet.
   */
  async describeIncidentState(
    sessionKey: string,
  ): Promise<PluginJsonValue | undefined> {
    const described = await this.request<SessionsDescribeResult>(
      "sessions.describe",
      { key: sessionKey },
    );
    if (!described.session) {
      return undefined;
    }
    return described.session.pluginExtensions?.find(
      (extension) =>
        extension.pluginId === GUARDIAN_PLUGIN_ID &&
        extension.namespace === INCIDENT_STATE_NAMESPACE,
    )?.value;
  }

  private async ensureSessionExists(
    sessionKey: string,
    label: string,
  ): Promise<void> {
    const described = await this.request<SessionsDescribeResult>(
      "sessions.describe",
      { key: sessionKey },
    );
    if (described.session) {
      return;
    }
    await this.request("sessions.create", {
      key: sessionKey,
      agentId: BRIDGE_AGENT_ID,
      label,
    });
  }

  /**
   * Creates the session if needed and durably writes `state` through
   * `sessions.pluginPatch`, verifying the echoed value matches exactly.
   * Throws `GatewayPersistenceError` on any RPC failure or echo mismatch;
   * the caller must not acknowledge the webhook when this throws.
   */
  async persistIncidentState(
    sessionKey: string,
    state: IncidentState,
  ): Promise<void> {
    await this.ensureSessionExists(
      sessionKey,
      `DataOps Guardian incident ${state.occurrenceId}`,
    );
    const patched = await this.request<{ value: PluginJsonValue }>(
      "sessions.pluginPatch",
      {
        key: sessionKey,
        pluginId: GUARDIAN_PLUGIN_ID,
        namespace: INCIDENT_STATE_NAMESPACE,
        value: state,
      },
    );
    if (!deepEqualJson(patched.value, state)) {
      throw new GatewayPersistenceError(
        `gateway did not durably persist the expected incident state for ${sessionKey}`,
      );
    }
  }
}
