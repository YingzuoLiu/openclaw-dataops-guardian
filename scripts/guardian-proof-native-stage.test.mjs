import { spawnSync } from "node:child_process";
import {
  access,
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
  new URL("./guardian-proof-native-stage.sh", import.meta.url),
);
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
  const sandbox = await mkdtemp(join(tmpdir(), "guardian-native-stage-test-"));
  temporaryRoots.push(sandbox);
  const root = join(sandbox, "source");
  const fakeBin = join(sandbox, "bin");
  const npmLog = join(sandbox, "npm-invocation.log");
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await mkdir(join(root, "packages", "demo", "node_modules"), {
    recursive: true,
  });
  await mkdir(fakeBin, { recursive: true });

  const helper = await readFile(helperPath, "utf8");
  await Promise.all([
    writeFile(
      join(root, ".gitignore"),
      "node_modules/\npackages/*/node_modules/\n",
    ),
    writeFile(join(root, "package.json"), '{"name":"fixture"}\n'),
    writeFile(
      join(root, "package-lock.json"),
      '{"name":"fixture","lockfileVersion":3,"packages":{}}\n',
    ),
    writeFile(join(root, "node_modules", "source-only-marker"), "root\n"),
    writeFile(
      join(root, "packages", "demo", "node_modules", "source-only-marker"),
      "nested\n",
    ),
    writeFile(join(root, "scripts", "guardian-proof-native-stage.sh"), helper),
    writeFile(
      join(root, "scripts", "entry.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
source "$ROOT_DIR/scripts/guardian-proof-native-stage.sh"
guardian_reexec_proof_on_native_fs "$ROOT_DIR" scripts/entry.sh demo "$@"
if [[ "\${GUARDIAN_PROOF_NATIVE_STAGED:-0}" == "1" &&
  "$1" == forge-child-commit ]]; then
  GUARDIAN_PROOF_SOURCE_COMMIT=0000000000000000000000000000000000000000
  export GUARDIAN_PROOF_SOURCE_COMMIT
fi
guardian_require_proof_source_commit "$ROOT_DIR"
test "\${GUARDIAN_PROOF_NATIVE_STAGED:-0}" = 1
test -f node_modules/installed-by-fake-npm
test ! -e node_modules/source-only-marker
test ! -e packages/demo/node_modules/source-only-marker
test -d "$TMPDIR"
actual_commit="$(git rev-parse HEAD)"
printf '{"cwd":"%s","tmpdir":"%s","arg":"%s","commit":"%s","head":"%s"}\n' \
  "$PWD" "$TMPDIR" "$1" "$GUARDIAN_PROOF_SOURCE_COMMIT" "$actual_commit"
if [[ "$1" == fail ]]; then
  exit 23
fi
`,
    ),
    writeFile(
      join(fakeBin, "npm"),
      `#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s\n' "$PWD" >>"$FAKE_NPM_LOG"
printf 'arg=%s\n' "$@" >>"$FAKE_NPM_LOG"
test ! -e node_modules/source-only-marker
test ! -e packages/demo/node_modules/source-only-marker
if [[ -n "\${FAKE_NPM_SLEEP:-}" ]]; then
  sleep "$FAKE_NPM_SLEEP"
fi
if [[ "\${FAKE_NPM_FAIL:-0}" == "1" ]]; then
  for index in $(seq -w 1 140); do
    printf 'fake-install-diagnostic-%s\n' "$index" >&2
  done
  exit "\${FAKE_NPM_STATUS:-37}"
fi
mkdir -p node_modules
printf 'installed\n' >node_modules/installed-by-fake-npm
`,
    ),
  ]);
  await Promise.all([
    chmod(join(root, "scripts", "entry.sh"), 0o755),
    chmod(join(fakeBin, "npm"), 0o755),
  ]);

  runGit(root, ["init", "--quiet"]);
  runGit(root, ["config", "user.name", "Guardian Test"]);
  runGit(root, ["config", "user.email", "guardian@example.test"]);
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "--quiet", "-m", "fixture"]);

  return {
    root,
    npmLog,
    fakeBin,
    commit: runGit(root, ["rev-parse", "HEAD"]),
  };
}

function runNativeStage(fixture, argument, extraEnv = {}) {
  return spawnSync("bash", ["scripts/entry.sh", argument], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      TMPDIR: join(fixture.root, "caller-tmp"),
      FAKE_NPM_LOG: fixture.npmLog,
      GUARDIAN_PROOF_FORCE_NATIVE_STAGE: "1",
      GUARDIAN_PROOF_NATIVE_STAGE_TIMEOUT: "30s",
      GUARDIAN_PROOF_NATIVE_INSTALL_TIMEOUT: "30s",
      ...extraEnv,
    },
  });
}

async function readInvocation(npmLog) {
  return readFile(npmLog, "utf8");
}

function stagedRepoFromInvocation(invocation) {
  return invocation.match(/^cwd=(.+)$/m)?.[1];
}

describe("native proof staging", () => {
  it("checks out clean HEAD, installs from the lockfile, and deletes the capsule", async () => {
    const fixture = await createFixture();
    const result = runNativeStage(fixture, "accepted");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[demo] native WSL staging");
    expect(result.stderr).toContain("[demo] native WSL dependency install");
    expect(result.stderr).toContain("[demo] native WSL staging complete");
    const report = JSON.parse(result.stdout.trim());
    expect(report.arg).toBe("accepted");
    expect(report.commit).toBe(fixture.commit);
    expect(report.head).toBe(fixture.commit);
    expect(report.cwd).toMatch(/^\/tmp\/guardian-proof-native\.[^/]+\/repo$/);
    expect(report.tmpdir).toBe(report.cwd.replace(/\/repo$/, "/tmp"));
    await expect(access(report.cwd)).rejects.toThrow();
    await expect(access(report.tmpdir)).rejects.toThrow();

    const invocation = await readInvocation(fixture.npmLog);
    expect(
      invocation.split("\n").filter((line) => line.startsWith("arg=")),
    ).toEqual([
      "arg=ci",
      "arg=--ignore-scripts",
      "arg=--no-audit",
      "arg=--no-fund",
      "arg=--prefer-offline",
    ]);
    expect(
      await readFile(
        join(fixture.root, "node_modules", "source-only-marker"),
        "utf8",
      ),
    ).toBe(
      "root\n",
    );
  });

  it("rejects a dirty source tree before invoking npm", async () => {
    const fixture = await createFixture();
    await writeFile(join(fixture.root, "untracked-change"), "dirty\n");
    const result = runNativeStage(fixture, "accepted", {
      GUARDIAN_PROOF_NATIVE_STAGED: "1",
      GUARDIAN_PROOF_SOURCE_COMMIT: fixture.commit,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "proof source worktree must be clean before execution",
    );
    await expect(access(fixture.npmLog)).rejects.toThrow();
  });

  it("preserves install failure status, bounds diagnostics, and cleans up", async () => {
    const fixture = await createFixture();
    const result = runNativeStage(fixture, "accepted", {
      FAKE_NPM_FAIL: "1",
      FAKE_NPM_STATUS: "37",
    });

    expect(result.status).toBe(37);
    expect(result.stderr).toContain(
      "native proof dependency install failed (exit 37)",
    );
    expect(result.stderr).toContain("last dependency install diagnostic lines:");
    expect(result.stderr).toContain("fake-install-diagnostic-140");
    expect(result.stderr).not.toContain("fake-install-diagnostic-001\n");
    const stagedRepo = stagedRepoFromInvocation(
      await readInvocation(fixture.npmLog),
    );
    expect(stagedRepo).toBeDefined();
    await expect(access(stagedRepo)).rejects.toThrow();
    await expect(access(join(stagedRepo, ".."))).rejects.toThrow();
  });

  it("returns 124, skips the child, and cleans up on install timeout", async () => {
    const fixture = await createFixture();
    const result = runNativeStage(fixture, "accepted", {
      FAKE_NPM_SLEEP: "5",
      GUARDIAN_PROOF_NATIVE_INSTALL_TIMEOUT: "1s",
    });

    expect(result.status).toBe(124);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "native proof dependency install failed (exit 124)",
    );
    expect(result.stderr).not.toContain("[demo] native WSL staging complete");
    const stagedRepo = stagedRepoFromInvocation(
      await readInvocation(fixture.npmLog),
    );
    expect(stagedRepo).toBeDefined();
    await expect(access(stagedRepo)).rejects.toThrow();
    await expect(access(join(stagedRepo, ".."))).rejects.toThrow();
  });

  it("preserves a child failure status and still deletes the capsule", async () => {
    const fixture = await createFixture();
    const result = runNativeStage(fixture, "fail");

    expect(result.status).toBe(23);
    const report = JSON.parse(result.stdout.trim());
    expect(report.commit).toBe(fixture.commit);
    await expect(access(report.cwd)).rejects.toThrow();
    await expect(access(report.tmpdir)).rejects.toThrow();
  });

  it("never checks out ignored untracked node_modules from the source", async () => {
    const fixture = await createFixture();
    const result = runNativeStage(fixture, "accepted");

    expect(result.status).toBe(0);
    const invocation = await readInvocation(fixture.npmLog);
    const stagedRepo = stagedRepoFromInvocation(invocation);
    expect(stagedRepo).toBeDefined();
    expect(result.stderr).not.toContain("unexpectedly contained node_modules");
    expect(result.stdout).toContain(fixture.commit);
  });

  it("makes the staged child independently reject a forged source commit", async () => {
    const fixture = await createFixture();
    const result = runNativeStage(fixture, "forge-child-commit");

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "inherited proof source commit does not match checked-out HEAD",
    );
    const stagedRepo = stagedRepoFromInvocation(
      await readInvocation(fixture.npmLog),
    );
    expect(stagedRepo).toBeDefined();
    await expect(access(stagedRepo)).rejects.toThrow();
    await expect(access(join(stagedRepo, ".."))).rejects.toThrow();
  });

  it("exports exact verified HEAD on native storage", async () => {
    const fixture = await createFixture();
    const native = spawnSync(
      "bash",
      [
        "-c",
        'source "$1"; guardian_require_proof_source_commit "$2"; printf "%s\\n" "$GUARDIAN_PROOF_SOURCE_COMMIT"',
        "guardian-native-source-test",
        helperPath,
        fixture.root,
      ],
      { cwd: fixture.root, encoding: "utf8", env: { ...process.env } },
    );
    expect(native.status).toBe(0);
    expect(native.stdout.trim()).toBe(fixture.commit);
  });
});
