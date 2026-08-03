import { describe, expect, it, vi } from "vitest";

import { readRuntimeIncidentState } from "./runtime-incident-state-reader.js";

const NAMESPACE = "incident";
const SESSION_KEY = "agent:main:some-session";
const INCIDENT_VALUE = { schemaVersion: 3, stage: "remediation" };

function runtimeWithEntry(entry: unknown, getSessionEntry?: (params: unknown) => unknown) {
  return {
    agent: {
      session: {
        getSessionEntry:
          getSessionEntry ?? (() => entry),
      },
    },
  };
}

describe("readRuntimeIncidentState", () => {
  it("returns the persisted value when the full path resolves", () => {
    const entry = {
      pluginExtensions: { "dataops-guardian": { incident: INCIDENT_VALUE } },
    };
    const result = readRuntimeIncidentState(
      runtimeWithEntry(entry),
      SESSION_KEY,
      NAMESPACE,
    );
    expect(result).toEqual(INCIDENT_VALUE);
  });

  it("calls getSessionEntry with exactly the given sessionKey", () => {
    const getSessionEntry = vi.fn(() => ({
      pluginExtensions: { "dataops-guardian": { incident: INCIDENT_VALUE } },
    }));
    readRuntimeIncidentState(
      runtimeWithEntry(undefined, getSessionEntry),
      SESSION_KEY,
      NAMESPACE,
    );
    expect(getSessionEntry).toHaveBeenCalledWith({ sessionKey: SESSION_KEY });
  });

  it("fails closed when sessionKey is undefined", () => {
    const entry = {
      pluginExtensions: { "dataops-guardian": { incident: INCIDENT_VALUE } },
    };
    expect(
      readRuntimeIncidentState(runtimeWithEntry(entry), undefined, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when sessionKey is empty", () => {
    const entry = {
      pluginExtensions: { "dataops-guardian": { incident: INCIDENT_VALUE } },
    };
    expect(
      readRuntimeIncidentState(runtimeWithEntry(entry), "", NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when runtime is undefined", () => {
    expect(
      readRuntimeIncidentState(undefined, SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when runtime is not an object", () => {
    expect(
      readRuntimeIncidentState("not-an-object", SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
    expect(
      readRuntimeIncidentState(42, SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
    expect(
      readRuntimeIncidentState(null, SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when runtime.agent is missing", () => {
    expect(
      readRuntimeIncidentState({}, SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when runtime.agent.session is missing", () => {
    expect(
      readRuntimeIncidentState({ agent: {} }, SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when getSessionEntry is not a function", () => {
    expect(
      readRuntimeIncidentState(
        { agent: { session: { getSessionEntry: "not-a-function" } } },
        SESSION_KEY,
        NAMESPACE,
      ),
    ).toBeUndefined();
  });

  it("fails closed when getSessionEntry throws", () => {
    const runtime = runtimeWithEntry(undefined, () => {
      throw new Error("boom");
    });
    expect(
      readRuntimeIncidentState(runtime, SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when getSessionEntry returns undefined (no session entry)", () => {
    expect(
      readRuntimeIncidentState(runtimeWithEntry(undefined), SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when getSessionEntry returns a non-object", () => {
    expect(
      readRuntimeIncidentState(runtimeWithEntry("not-an-entry"), SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when the entry has no pluginExtensions", () => {
    expect(
      readRuntimeIncidentState(runtimeWithEntry({}), SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when pluginExtensions has no dataops-guardian slot", () => {
    const entry = { pluginExtensions: { "some-other-plugin": { incident: INCIDENT_VALUE } } };
    expect(
      readRuntimeIncidentState(runtimeWithEntry(entry), SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });

  it("fails closed when the dataops-guardian slot has no incident namespace", () => {
    const entry = { pluginExtensions: { "dataops-guardian": { "other-namespace": {} } } };
    expect(
      readRuntimeIncidentState(runtimeWithEntry(entry), SESSION_KEY, NAMESPACE),
    ).toBeUndefined();
  });
});
