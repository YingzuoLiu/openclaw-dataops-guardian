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
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "guardian-native-stage-test-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".gitignore"), "node_modules/\nignored-secret\n"),
    writeFile(join(root, "node_modules", "marker"), "installed\n"),
    writeFile(join(root, "ignored-secret"), "must not be staged\n"),
    writeFile(
      join(root, "scripts", "entry.sh"),
      `#!/usr/bin/env bash
set -euo pipefail
test "\${GUARDIAN_PROOF_NATIVE_STAGED:-0}" = 1
test -f node_modules/marker
test ! -e ignored-secret
test -d "$TMPDIR"
printf '{"cwd":"%s","tmpdir":"%s","arg":"%s"}\\n' "$PWD" "$TMPDIR" "$1"
if [[ "$1" == fail ]]; then
  exit 23
fi
`,
    ),
  ]);
  await chmod(join(root, "scripts", "entry.sh"), 0o755);
  runGit(root, ["init", "--quiet"]);
  runGit(root, ["add", ".gitignore", "scripts/entry.sh"]);
  return root;
}

function runNativeStage(root, argument) {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"; guardian_reexec_proof_on_native_fs "$2" scripts/entry.sh demo "$3"; echo unexpected-continuation',
      "guardian-native-stage-test",
      helperPath,
      root,
      argument,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: join(root, "caller-tmp"),
        GUARDIAN_PROOF_FORCE_NATIVE_STAGE: "1",
        GUARDIAN_PROOF_NATIVE_STAGE_TIMEOUT: "30s",
      },
    },
  );
}

describe("native proof staging", () => {
  it("re-executes from private Linux storage and deletes the mirror", async () => {
    const root = await createFixture();
    const result = runNativeStage(root, "accepted");

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[demo] native WSL staging");
    expect(result.stderr).toContain("[demo] native WSL staging complete");
    expect(result.stdout).not.toContain("unexpected-continuation");
    const report = JSON.parse(result.stdout.trim());
    expect(report.arg).toBe("accepted");
    expect(report.cwd).toMatch(/^\/tmp\/guardian-proof-native\.[^/]+\/repo$/);
    expect(report.tmpdir).toBe(report.cwd.replace(/\/repo$/, "/tmp"));
    await expect(access(report.cwd)).rejects.toThrow();
    await expect(access(report.tmpdir)).rejects.toThrow();

    expect(await readFile(join(root, "ignored-secret"), "utf8")).toContain(
      "must not be staged",
    );
  });

  it("preserves a child failure status and still deletes the mirror", async () => {
    const root = await createFixture();
    const result = runNativeStage(root, "fail");

    expect(result.status).toBe(23);
    expect(result.stdout).not.toContain("unexpected-continuation");
    const report = JSON.parse(result.stdout.trim());
    await expect(access(report.cwd)).rejects.toThrow();
    await expect(access(report.tmpdir)).rejects.toThrow();
  });
});
