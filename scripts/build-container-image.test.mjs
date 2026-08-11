import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "guardian-container-build-test-"));
  temporaryRoots.push(root);
  const scriptsDir = join(root, "scripts");
  const containerDir = join(root, "container");
  const fakeBin = join(root, "fake-bin");
  const dockerLog = join(root, "docker.log");
  await Promise.all([
    mkdir(scriptsDir, { recursive: true }),
    mkdir(containerDir, { recursive: true }),
    mkdir(join(root, "src"), { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
  ]);

  const [buildScript, sourceGuard] = await Promise.all([
    readFile(join(repositoryRoot, "scripts", "build-container-image.sh"), "utf8"),
    readFile(
      join(repositoryRoot, "scripts", "guardian-proof-native-stage.sh"),
      "utf8",
    ),
  ]);
  await Promise.all([
    writeFile(join(scriptsDir, "build-container-image.sh"), buildScript),
    writeFile(join(scriptsDir, "guardian-proof-native-stage.sh"), sourceGuard),
    writeFile(
      join(root, ".gitignore"),
      "dist/\ndist-runtime/\n.env\nfake-bin/\ntool-bin/\n",
    ),
    writeFile(join(root, ".dockerignore"), "**\n!container/**\n!package*.json\n!src/**\n"),
    writeFile(join(root, "package.json"), '{"name":"fixture","version":"0.3.0"}\n'),
    writeFile(join(root, "package-lock.json"), "{}\n"),
    writeFile(join(root, "src", "index.ts"), "export {};\n"),
    writeFile(join(containerDir, "Dockerfile"), "FROM scratch\n"),
    writeFile(join(containerDir, "package-lock.json"), "{}\n"),
    writeFile(join(containerDir, "runtime-contract.mjs"), "export {};\n"),
    writeFile(
      join(fakeBin, "docker"),
      `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" >"$GUARDIAN_TEST_DOCKER_LOG"
context="\${!#}"
test ! -e "$context/.git"
test ! -e "$context/.env"
test ! -e "$context/dist/ignored-sentinel.js"
printf '%s\n' "$context" >>"$GUARDIAN_TEST_DOCKER_LOG"
`,
    ),
  ]);
  await Promise.all([
    chmod(join(scriptsDir, "build-container-image.sh"), 0o755),
    chmod(join(fakeBin, "docker"), 0o755),
  ]);

  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.name", "Guardian Test"]);
  runGit(root, ["config", "user.email", "guardian@example.test"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "fixture"]);

  await mkdir(join(root, "dist"), { recursive: true });
  await Promise.all([
    writeFile(join(root, "dist", "ignored-sentinel.js"), "ignored\n"),
    writeFile(join(root, ".env"), "SENTINEL=must-not-enter-context\n"),
  ]);
  return {
    root,
    fakeBin,
    dockerLog,
    commit: runGit(root, ["rev-parse", "HEAD"]),
  };
}

function runBuild(fixture, extraEnv = {}, image = "guardian:test") {
  return spawnSync("bash", ["scripts/build-container-image.sh", image], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      GUARDIAN_TEST_DOCKER_LOG: fixture.dockerLog,
      GUARDIAN_PROOF_SOURCE_COMMIT: "",
      ...extraEnv,
    },
  });
}

describe("source-bound container build", () => {
  it("builds from a private exact-commit archive and passes the full SHA", async () => {
    const fixture = await createFixture();

    const result = runBuild(fixture);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      ok: true,
      image: "guardian:test",
      guardianVersion: "0.3.0",
      sourceRevision: fixture.commit,
    });
    const invocation = await readFile(fixture.dockerLog, "utf8");
    expect(invocation).toContain("--platform\nlinux/amd64\n");
    expect(invocation).toContain(
      `--build-arg\nGUARDIAN_SOURCE_REVISION=${fixture.commit}\n`,
    );
    expect(invocation).toContain("--build-arg\nGUARDIAN_VERSION=0.3.0\n");
    const stagedContext = invocation.trim().split("\n").at(-1);
    expect(stagedContext).toMatch(/^\/tmp\/guardian-container-build\./);
    await expect(readFile(join(stagedContext, "package.json"))).rejects.toThrow();
  });

  it.each(["tracked", "untracked"])(
    "rejects a dirty %s change before invoking Docker",
    async (kind) => {
      const fixture = await createFixture();
      if (kind === "tracked") {
        await writeFile(join(fixture.root, "package.json"), '{"version":"9.9.9"}\n');
      } else {
        await writeFile(join(fixture.root, "untracked.txt"), "dirty\n");
      }

      const result = runBuild(fixture);

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("proof source worktree must be clean");
      await expect(readFile(fixture.dockerLog)).rejects.toThrow();
    },
  );

  it("rejects a forged inherited source commit", async () => {
    const fixture = await createFixture();
    const result = runBuild(fixture, {
      GUARDIAN_PROOF_SOURCE_COMMIT: "0".repeat(40),
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "inherited proof source commit does not match checked-out HEAD",
    );
    await expect(readFile(fixture.dockerLog)).rejects.toThrow();
  });

  it("fails before archiving when Docker is unavailable", async () => {
    const fixture = await createFixture();
    await chmod(join(fixture.fakeBin, "docker"), 0o644);
    const toolBin = join(fixture.root, "tool-bin");
    await mkdir(toolBin);
    for (const command of ["dirname", "find", "git", "mktemp", "mkdir", "node", "tar"]) {
      const resolved = spawnSync("bash", ["-lc", `command -v ${command}`], {
        encoding: "utf8",
      }).stdout.trim();
      await symlink(resolved, join(toolBin, command));
    }

    const result = spawnSync("/bin/bash", ["scripts/build-container-image.sh"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: toolBin,
        GUARDIAN_PROOF_SOURCE_COMMIT: "",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("container image build requires docker");
    await expect(readFile(fixture.dockerLog)).rejects.toThrow();
  });
});
