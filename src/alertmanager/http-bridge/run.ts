import { join } from "node:path";

import { AuditLog } from "./audit.js";
import { BridgeStateStore } from "./bridge-state.js";
import { loadBridgeConfigFromEnv } from "./config.js";
import { FingerprintLock } from "./fingerprint-lock.js";
import { GatewayIncidentClient } from "./gateway-incident-client.js";
import { assertDurableDirectoryWritable } from "./json-store.js";
import { drainPendingCheckpoint, type ProcessorDeps } from "./processor.js";
import { createHttpBridgeServer } from "./server.js";

/**
 * Standalone executable entrypoint for the Alertmanager HTTP bridge. This is
 * deliberately not wired into `src/index.ts`'s OpenClaw plugin `register()`:
 * the bridge is an external process that talks to the Gateway over the same
 * RPC surface any other operator client uses, not plugin code loaded in the
 * Gateway process.
 */
async function main(): Promise<void> {
  const config = loadBridgeConfigFromEnv();

  // Do not connect to the Gateway or expose the webhook listener until the
  // bridge has proved that its checkpoint/audit mount supports the durable
  // write sequence those safety records require.
  assertDurableDirectoryWritable(config.stateDir);

  const bridgeState = new BridgeStateStore(join(config.stateDir, "bridge-state.json"));
  const audit = new AuditLog(join(config.stateDir, "audit.jsonl"));
  const gateway = new GatewayIncidentClient({
    url: config.gatewayUrl,
    token: config.gatewayToken,
    clientDisplayName: "dataops-guardian-alertmanager-bridge",
    requestTimeoutMs: config.gatewayRequestTimeoutMs,
    connectTimeoutMs: config.gatewayConnectTimeoutMs,
  });
  await gateway.connect();

  const deps: ProcessorDeps = {
    bridgeState,
    gateway,
    audit,
    now: () => new Date().toISOString(),
  };

  // Settle (or confirm still-held) any checkpoints left over from a
  // previous run before accepting new traffic. A checkpoint whose blocking
  // remediation attempt is still `running` stays held; nothing here starts,
  // cancels, or investigates that attempt.
  for (const fingerprint of bridgeState.listCheckpointFingerprints()) {
    await drainPendingCheckpoint(deps, fingerprint);
  }

  const server = createHttpBridgeServer({
    ...deps,
    bearerToken: config.bearerToken,
    fingerprintLock: new FingerprintLock(),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, () => resolve());
  });

  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      msg: "alertmanager http bridge listening",
      host: config.host,
      port: config.port,
    })}\n`,
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close(() => {
      gateway
        .close()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
