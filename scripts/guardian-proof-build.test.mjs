import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const helperPath = fileURLToPath(
  new URL("./guardian-proof-build.sh", import.meta.url),
);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function createFixture({ completePlugin = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "guardian-proof-build-test-"));
  temporaryRoots.push(root);
  const binDir = join(root, "bin");
  const pluginDir = join(root, "plugin");
  const logPath = join(root, "npm.log");
  const stampPath = join(root, "prebuilt.stamp");
  const extraArtifact = join(root, "root-dist.js");

  await mkdir(join(pluginDir, "dist"), { recursive: true });
  await mkdir(binDir);
  await Promise.all([
    writeFile(join(pluginDir, "package.json"), "{}\n"),
    writeFile(join(pluginDir, "openclaw.plugin.json"), "{}\n"),
    writeFile(stampPath, `${pluginDir}\n`),
    writeFile(extraArtifact, "export {};\n"),
    writeFile(
      join(binDir, "npm"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >>"$GUARDIAN_TEST_NPM_LOG"\n',
    ),
  ]);
  if (completePlugin) {
    await writeFile(join(pluginDir, "dist/index.js"), "export {};\n");
  }
  await chmod(join(binDir, "npm"), 0o755);

  return { root, binDir, pluginDir, logPath, stampPath, extraArtifact };
}

function runGuard(fixture, env = {}, artifacts = []) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; guardian_build_or_verify_prebuilt "${@:2}"',
      "guardian-proof-build-test",
      helperPath,
      ...artifacts,
    ],
    {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fixture.binDir}:${process.env.PATH}`,
        GUARDIAN_TEST_NPM_LOG: fixture.logPath,
        GUARDIAN_PROOF_PREBUILT_STAMP: "",
        GUARDIAN_PROOF_PLUGIN_DIR: "",
        ...env,
      },
    },
  );
}

async function readNpmLog(path) {
  return readFile(path, "utf8").catch(() => "");
}

describe("proof build guard", () => {
  it("builds by default for a standalone component", async () => {
    const fixture = await createFixture();

    const result = runGuard(fixture);

    expect(result.status).toBe(0);
    expect(await readNpmLog(fixture.logPath)).toBe("run build\n");
  });

  it("reuses a complete artifact tied to the run-owned stamp", async () => {
    const fixture = await createFixture();

    const result = runGuard(
      fixture,
      {
        GUARDIAN_PROOF_PREBUILT_STAMP: fixture.stampPath,
        GUARDIAN_PROOF_PLUGIN_DIR: fixture.pluginDir,
      },
      [fixture.extraArtifact],
    );

    expect(result.status).toBe(0);
    expect(await readNpmLog(fixture.logPath)).toBe("");
  });

  it("fails closed when a stamped plugin artifact is incomplete", async () => {
    const fixture = await createFixture({ completePlugin: false });

    const result = runGuard(fixture, {
      GUARDIAN_PROOF_PREBUILT_STAMP: fixture.stampPath,
      GUARDIAN_PROOF_PLUGIN_DIR: fixture.pluginDir,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("prebuilt proof artifact is missing");
    expect(await readNpmLog(fixture.logPath)).toBe("");
  });

  it("fails closed when the stamp belongs to a different plugin path", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.stampPath, `${join(fixture.root, "other-plugin")}\n`);

    const result = runGuard(fixture, {
      GUARDIAN_PROOF_PREBUILT_STAMP: fixture.stampPath,
      GUARDIAN_PROOF_PLUGIN_DIR: fixture.pluginDir,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "prebuilt proof stamp does not match the staged plugin",
    );
    expect(await readNpmLog(fixture.logPath)).toBe("");
  });
});
