import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendJsonLineDurable,
  deleteFileIfPresent,
  readJsonFileOrUndefined,
  writeJsonFileDurable,
} from "./json-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "guardian-json-store-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeJsonFileDurable / readJsonFileOrUndefined", () => {
  it("round-trips a value and leaves no temp file behind", () => {
    const path = join(dir, "state.json");
    writeJsonFileDurable(path, { schemaVersion: 1, routes: {} });
    expect(readJsonFileOrUndefined(path)).toEqual({ schemaVersion: 1, routes: {} });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("overwrites atomically on repeated writes", () => {
    const path = join(dir, "state.json");
    writeJsonFileDurable(path, { n: 1 });
    writeJsonFileDurable(path, { n: 2 });
    writeJsonFileDurable(path, { n: 3 });
    expect(readJsonFileOrUndefined(path)).toEqual({ n: 3 });
    expect(readdirSync(dir)).toEqual(["state.json"]);
  });

  it("returns undefined for a missing file", () => {
    expect(readJsonFileOrUndefined(join(dir, "missing.json"))).toBeUndefined();
  });

  it("creates parent directories as needed", () => {
    const path = join(dir, "nested", "state.json");
    writeJsonFileDurable(path, { ok: true });
    expect(readJsonFileOrUndefined(path)).toEqual({ ok: true });
  });
});

describe("deleteFileIfPresent", () => {
  it("removes an existing file", () => {
    const path = join(dir, "checkpoint.json");
    writeJsonFileDurable(path, { held: true });
    deleteFileIfPresent(path);
    expect(readJsonFileOrUndefined(path)).toBeUndefined();
  });

  it("is a no-op when the file does not exist", () => {
    expect(() => deleteFileIfPresent(join(dir, "missing.json"))).not.toThrow();
  });
});

describe("appendJsonLineDurable", () => {
  it("appends newline-delimited JSON records", () => {
    const path = join(dir, "audit.jsonl");
    appendJsonLineDurable(path, { seq: 1 });
    appendJsonLineDurable(path, { seq: 2 });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line))).toEqual([{ seq: 1 }, { seq: 2 }]);
  });
});
