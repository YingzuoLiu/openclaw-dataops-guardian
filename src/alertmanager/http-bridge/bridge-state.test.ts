import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BridgeStateStore, decodeBridgeState } from "./bridge-state.js";
import type { DeferredAlertDeliveryCheckpoint } from "../ingestion.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guardian-bridge-state-"));
  path = join(dir, "bridge-state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function checkpoint(
  overrides: Partial<DeferredAlertDeliveryCheckpoint> = {},
): DeferredAlertDeliveryCheckpoint {
  return {
    schemaVersion: 1,
    checkpointId: "checkpoint-1",
    blockedByOccurrenceId: "occurrence-blocking",
    delivery: {
      alertId: "alert-1",
      fingerprint: "fingerprint-1",
      alertStatus: "firing",
      startsAt: "2026-08-01T01:00:00.000Z",
      endsAt: null,
      receivedAt: "2026-08-01T01:00:01.000Z",
      deliveryId: "delivery-next",
    },
    ...overrides,
  };
}

describe("decodeBridgeState", () => {
  it("returns an empty state for a missing file", () => {
    expect(decodeBridgeState(undefined)).toEqual({
      schemaVersion: 1,
      routes: {},
      checkpoints: {},
    });
  });

  it("rejects an unsupported schema version", () => {
    expect(() => decodeBridgeState({ schemaVersion: 2, routes: {}, checkpoints: {} })).toThrow();
  });

  it("rejects a malformed route entry", () => {
    expect(() =>
      decodeBridgeState({
        schemaVersion: 1,
        routes: { "fingerprint-1": { occurrenceId: "" } },
        checkpoints: {},
      }),
    ).toThrow();
  });

  it("rejects a route whose sessionKey is not the deterministic function of its occurrenceId", () => {
    expect(() =>
      decodeBridgeState({
        schemaVersion: 1,
        routes: {
          "fingerprint-1": {
            occurrenceId: "occurrence-1",
            sessionKey: "agent:main:dataops-guardian-incident-some-other-occurrence",
          },
        },
        checkpoints: {},
      }),
    ).toThrow();
  });

  it("rejects a checkpoint whose delivery is not a structurally valid AlertDelivery", () => {
    expect(() =>
      decodeBridgeState({
        schemaVersion: 1,
        routes: {},
        checkpoints: {
          "fingerprint-1": {
            schemaVersion: 1,
            checkpointId: "checkpoint-1",
            blockedByOccurrenceId: "occurrence-blocking",
            delivery: { fingerprint: "fingerprint-1" },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects a checkpoint filed under a fingerprint that does not match its delivery", () => {
    expect(() =>
      decodeBridgeState({
        schemaVersion: 1,
        routes: {},
        checkpoints: { "fingerprint-1": checkpoint({ delivery: { ...checkpoint().delivery, fingerprint: "fingerprint-2" } }) },
      }),
    ).toThrow();
  });

  it("rejects a checkpoint whose blockedByOccurrenceId does not match the fingerprint's route", () => {
    expect(() =>
      decodeBridgeState({
        schemaVersion: 1,
        routes: {
          "fingerprint-1": {
            occurrenceId: "occurrence-active",
            sessionKey: "agent:main:dataops-guardian-incident-occurrence-active",
          },
        },
        checkpoints: {
          "fingerprint-1": checkpoint({ blockedByOccurrenceId: "occurrence-stale" }),
        },
      }),
    ).toThrow();
  });

  it("accepts a checkpoint whose blockedByOccurrenceId matches the fingerprint's route", () => {
    const state = decodeBridgeState({
      schemaVersion: 1,
      routes: {
        "fingerprint-1": {
          occurrenceId: "occurrence-active",
          sessionKey: "agent:main:dataops-guardian-incident-occurrence-active",
        },
      },
      checkpoints: {
        "fingerprint-1": checkpoint({ blockedByOccurrenceId: "occurrence-active" }),
      },
    });
    expect(state.checkpoints["fingerprint-1"]?.blockedByOccurrenceId).toBe("occurrence-active");
  });
});

describe("BridgeStateStore", () => {
  it("starts empty when no file exists yet", () => {
    const store = new BridgeStateStore(path);
    expect(store.getRoute("fingerprint-1")).toBeUndefined();
    expect(store.getCheckpoint("fingerprint-1")).toBeUndefined();
    expect(store.listCheckpointFingerprints()).toEqual([]);
  });

  it("persists a route durably and reloads it in a fresh store instance", () => {
    const store = new BridgeStateStore(path);
    store.setRoute("fingerprint-1", {
      occurrenceId: "occurrence-1",
      sessionKey: "agent:main:dataops-guardian-incident-occurrence-1",
    });

    const reloaded = new BridgeStateStore(path);
    expect(reloaded.getRoute("fingerprint-1")).toEqual({
      occurrenceId: "occurrence-1",
      sessionKey: "agent:main:dataops-guardian-incident-occurrence-1",
    });
  });

  it("persists a checkpoint durably and reloads it", () => {
    const store = new BridgeStateStore(path);
    const cp = checkpoint();
    store.setCheckpoint("fingerprint-1", cp);

    const reloaded = new BridgeStateStore(path);
    expect(reloaded.getCheckpoint("fingerprint-1")).toEqual(cp);
    expect(reloaded.listCheckpointFingerprints()).toEqual(["fingerprint-1"]);
  });

  it("commitRouteAndClearCheckpoint moves the route and clears the checkpoint atomically", () => {
    const store = new BridgeStateStore(path);
    store.setCheckpoint("fingerprint-1", checkpoint());
    store.setRoute("fingerprint-1", {
      occurrenceId: "occurrence-old",
      sessionKey: "agent:main:dataops-guardian-incident-occurrence-old",
    });

    store.commitRouteAndClearCheckpoint("fingerprint-1", {
      occurrenceId: "occurrence-new",
      sessionKey: "agent:main:dataops-guardian-incident-occurrence-new",
    });

    const reloaded = new BridgeStateStore(path);
    expect(reloaded.getRoute("fingerprint-1")).toEqual({
      occurrenceId: "occurrence-new",
      sessionKey: "agent:main:dataops-guardian-incident-occurrence-new",
    });
    expect(reloaded.getCheckpoint("fingerprint-1")).toBeUndefined();
  });

  it("deleteCheckpoint is idempotent", () => {
    const store = new BridgeStateStore(path);
    store.setCheckpoint("fingerprint-1", checkpoint());
    store.deleteCheckpoint("fingerprint-1");
    expect(() => store.deleteCheckpoint("fingerprint-1")).not.toThrow();
    expect(store.getCheckpoint("fingerprint-1")).toBeUndefined();
  });

  it("throws when the state file on disk is invalid JSON", () => {
    writeFileSync(path, "{ not json", "utf8");
    expect(() => new BridgeStateStore(path)).toThrow();
  });

  it("refuses to start from an existing-but-empty state file rather than treating it as fresh", () => {
    writeFileSync(path, "", "utf8");
    expect(() => new BridgeStateStore(path)).toThrow();
  });
});
