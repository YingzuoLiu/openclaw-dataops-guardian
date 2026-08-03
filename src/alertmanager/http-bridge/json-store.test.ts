import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appendJsonLineDurable,
  deleteFileIfPresent,
  fsyncDirectoryIfSupported,
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

  it("throws for a file that exists but is empty, rather than treating it as missing", () => {
    const path = join(dir, "empty.json");
    writeFileSync(path, "", "utf8");
    expect(() => readJsonFileOrUndefined(path)).toThrow();
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

describe("fsyncDirectoryIfSupported", () => {
  // A nonexistent path makes `openSync` throw regardless of platform; using
  // it lets these tests prove the win32/POSIX branches deterministically on
  // whatever OS actually runs them, without mocking `node:fs` itself: the
  // win32 branch must never even attempt the open (so it never throws),
  // while every POSIX-like platform must attempt it and let the failure
  // propagate. `dir` is only assigned in `beforeEach`, so the missing path
  // built from it is computed per-test rather than at collection time.

  it("skips the directory fsync entirely on win32, even for a directory that doesn't exist", () => {
    expect(() =>
      fsyncDirectoryIfSupported(join(dir, "does-not-exist"), "win32"),
    ).not.toThrow();
  });

  // Unlike the two tests above (which only ever exercise the deliberately
  // failing `openSync` path, so a fake `platform` label is enough to select
  // the branch under test without depending on what the host OS actually
  // supports), this one calls `openSync`/`fsyncSync` on a directory that
  // really exists — so it must run the *real* directory fsync syscall on
  // whatever OS is actually executing the test. Passing a fake POSIX
  // `platform` label here while running on real Windows would still make
  // this function attempt the real (unsupported) Windows directory fsync
  // and throw `EPERM`, regardless of the label; it must only run where the
  // host itself is POSIX-like.
  it.skipIf(process.platform === "win32")(
    "fsyncs an existing directory without throwing on POSIX",
    () => {
      expect(() => fsyncDirectoryIfSupported(dir, process.platform)).not.toThrow();
    },
  );

  it("propagates a directory fsync failure on POSIX-like platforms", () => {
    const missingDir = join(dir, "does-not-exist");
    for (const platform of ["linux", "darwin"] as const) {
      expect(() => fsyncDirectoryIfSupported(missingDir, platform)).toThrow();
    }
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
