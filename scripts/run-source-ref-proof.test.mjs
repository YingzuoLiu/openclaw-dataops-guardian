import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const proofScript = join(repositoryRoot, "scripts", "run-source-ref-proof.sh");
const temporaryRoots = [];

function resolveCommand(command) {
  const result = spawnSync("bash", ["-lc", `command -v ${command}`], {
    encoding: "utf8",
  });
  if (result.status !== 0 || result.stdout.trim() === "") {
    throw new Error(`required test command is unavailable: ${command}`);
  }
  return result.stdout.trim();
}

const realGit = resolveCommand("git");
const realNpm = resolveCommand("npm");

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function runChecked(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function runGit(cwd, args) {
  return runChecked(realGit, args, cwd);
}

const fakeOpenClaw = `#!/usr/bin/env node
import {
  appendFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const inheritedNames = [
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_HOME",
];
const inherited = Object.fromEntries(
  inheritedNames.map((name) => [name, process.env[name] ?? null]),
);
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
const lobsterStateDir = process.env.LOBSTER_STATE_DIR ?? "";
appendFileSync(
  process.env.GUARDIAN_TEST_CLI_LOG,
  JSON.stringify({
    args,
    stateDir,
    lobsterStateDir,
    disableBundled: process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ?? null,
    ...inherited,
  }) + "\\n",
);

const leaked = inheritedNames.filter((name) => process.env[name] !== undefined);
if (leaked.length > 0) {
  throw new Error("caller OpenClaw environment leaked: " + leaked.join(", "));
}
if (!/^\\/tmp\\/guardian-source-release\\.[^/]+\\/openclaw-state$/.test(stateDir)) {
  throw new Error("OpenClaw state is not proof-owned: " + stateDir);
}
if (!/^\\/tmp\\/guardian-source-release\\.[^/]+\\/lobster-state$/.test(lobsterStateDir)) {
  throw new Error("Lobster state is not proof-owned: " + lobsterStateDir);
}
if (process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS !== "1") {
  throw new Error("bundled plugins were not disabled");
}
mkdirSync(stateDir, { recursive: true });
appendFileSync(join(stateDir, "fixture-writes.log"), args.join(" ") + "\\n");

if (args[0] === "plugins" && args[1] === "install") {
  if (args[2] !== "--link" || args.length !== 4 || !existsSync(args[3])) {
    throw new Error("plugins install did not use --link with an existing path");
  }
  process.exit(0);
}
if (args[0] === "plugins" && args[1] === "enable") {
  if (args.length !== 3) {
    throw new Error("plugins enable did not name exactly one plugin");
  }
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  if (args[2] !== "--batch-json" || args.length !== 4) {
    throw new Error("release configuration was not applied as one batch");
  }
  JSON.parse(args[3]);
  process.exit(0);
}
if (
  args[0] === "plugins" &&
  args[1] === "inspect" &&
  args[2] === "dataops-guardian" &&
  args[3] === "--runtime" &&
  args[4] === "--json"
) {
  process.stdout.write(
    JSON.stringify({
      plugin: { version: process.env.GUARDIAN_TEST_PLUGIN_VERSION },
      diagnostics: [],
      tools: [
        {
          names: [
            "guardian_verify_deployment_recovery",
            "guardian_rollback_deployment",
            "guardian_query_prometheus",
            "guardian_propose_remediation",
            "guardian_inspect_metric_snapshot",
          ],
        },
      ],
      typedHooks: [
        { name: "before_tool_call" },
        { name: "before_agent_run" },
        { name: "agent_end" },
        { name: "after_tool_call" },
        { name: "before_agent_finalize" },
      ],
    }) + "\\n",
  );
  process.exit(0);
}
if (
  args[0] === "plugins" &&
  args[1] === "inspect" &&
  args[2] === "lobster" &&
  args[3] === "--runtime" &&
  args[4] === "--json"
) {
  process.stdout.write(
    JSON.stringify({
      plugin: {
        version: "2026.6.34",
        contracts: { tools: ["lobster"] },
      },
      diagnostics: [],
      tools: [{ names: [], optional: true }],
    }) + "\\n",
  );
  process.exit(0);
}
throw new Error("unexpected OpenClaw invocation: " + args.join(" "));
`;

const fixturePostinstall = `
import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const inheritedNames = [
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_HOME",
];
const leaked = inheritedNames.filter((name) => process.env[name] !== undefined);
if (leaked.length > 0) {
  throw new Error("caller OpenClaw environment reached npm lifecycle: " + leaked.join(", "));
}
const stateDir = process.env.OPENCLAW_STATE_DIR ?? "";
const lobsterStateDir = process.env.LOBSTER_STATE_DIR ?? "";
if (!/^\\/tmp\\/guardian-source-release\\.[^/]+\\/openclaw-state$/.test(stateDir)) {
  throw new Error("npm lifecycle did not receive proof-owned state: " + stateDir);
}

if (!/^\\/tmp\\/guardian-source-release\\.[^/]+\\/lobster-state$/.test(lobsterStateDir)) {
  throw new Error("npm lifecycle did not receive proof-owned Lobster state: " + lobsterStateDir);
}

const openClawBin = join(process.cwd(), "node_modules", ".bin", "openclaw");
const openClawDir = join(process.cwd(), "node_modules", "openclaw");
const lobsterDir = join(
  process.cwd(),
  "node_modules",
  "@openclaw",
  "lobster",
);
await mkdir(join(process.cwd(), "node_modules", ".bin"), { recursive: true });
await mkdir(openClawDir, { recursive: true });
await mkdir(lobsterDir, { recursive: true });
await copyFile(new URL("./fixture-openclaw.mjs", import.meta.url), openClawBin);
await chmod(openClawBin, 0o755);
await writeFile(
  join(openClawDir, "package.json"),
  JSON.stringify({ name: "openclaw", version: "2026.6.34" }) + "\\n",
);
await writeFile(
  join(lobsterDir, "package.json"),
  JSON.stringify({ name: "@openclaw/lobster", version: "fixture" }) + "\\n",
);
await writeFile(
  process.env.GUARDIAN_TEST_POSTINSTALL_MARKER,
  JSON.stringify({
    stateDir,
    lobsterStateDir,
    configPath: process.env.OPENCLAW_CONFIG_PATH ?? null,
    profile: process.env.OPENCLAW_PROFILE ?? null,
    home: process.env.OPENCLAW_HOME ?? null,
  }) + "\\n",
);
`;

const fixtureBuild = `
import { writeFile } from "node:fs/promises";

const leaked = [
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_HOME",
].filter((name) => process.env[name] !== undefined);
if (leaked.length > 0) {
  throw new Error("caller OpenClaw environment reached build: " + leaked.join(", "));
}
await writeFile(process.env.GUARDIAN_TEST_BUILD_MARKER, "built\\n");
`;

const npmWrapper = `#!/usr/bin/env bash
set -euo pipefail
args=("$@")
if ((\${#args[@]} > 0)); then
  printf '%s' "\${args[0]}" >>"$GUARDIAN_TEST_NPM_LOG"
  for arg in "\${args[@]:1}"; do
    printf '\\t%s' "$arg" >>"$GUARDIAN_TEST_NPM_LOG"
  done
  printf '\\n' >>"$GUARDIAN_TEST_NPM_LOG"
fi
for arg in "\${args[@]}"; do
  if [[ "$arg" == "--ignore-scripts" ]]; then
    echo "source proof disabled lifecycle scripts" >&2
    exit 86
  fi
done
exec "$GUARDIAN_TEST_REAL_NPM" "\${args[@]}"
`;

const fixtureFastDemo = `#!/usr/bin/env bash
set -euo pipefail
commit="$(git rev-parse HEAD)"
printf '%s\\n' "$commit" >"$GUARDIAN_TEST_DEMO_MARKER"
printf '{"schemaVersion":1,"ok":true,"proof":"dataops-guardian-fast-demo","source":{"commit":"%s"},"components":{"policyRegistration":true,"liveAgentFinalizeGate":true,"httpBridgeAuthCheckpointCrashRecovery":true,"syntheticApproval":true,"syntheticDenial":true},"apiCostUsd":0}\\n' "$commit"
`;

async function createFixture({
  packageVersion = "0.3.0",
  releaseRef = "v0.3.0",
  tagKind = "lightweight",
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "guardian-source-release-test-"));
  temporaryRoots.push(root);
  const sourceDir = join(root, "source");
  const remoteDir = join(root, "remote.git");
  const fakeBin = join(root, "fake-bin");
  const callerDir = join(root, "caller");
  const callerHome = join(callerDir, "home");
  const callerState = join(callerDir, "state");
  const callerLobsterState = join(callerDir, "lobster-state");
  const callerConfig = join(callerDir, "config.json");
  const npmLog = join(root, "npm.log");
  const cliLog = join(root, "openclaw.jsonl");
  const postinstallMarker = join(root, "postinstall.json");
  const buildMarker = join(root, "build.marker");
  const demoMarker = join(root, "demo.marker");

  await Promise.all([
    mkdir(sourceDir, { recursive: true }),
    mkdir(join(sourceDir, "scripts"), { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(callerHome, { recursive: true }),
    mkdir(callerState, { recursive: true }),
    mkdir(callerLobsterState, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(sourceDir, "package.json"),
      `${JSON.stringify(
        {
          name: "guardian-source-release-fixture",
          version: packageVersion,
          private: true,
          type: "module",
          scripts: {
            build: "node fixture-build.mjs",
            postinstall: "node fixture-postinstall.mjs",
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      join(sourceDir, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "guardian-source-release-fixture",
          version: packageVersion,
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "guardian-source-release-fixture",
              version: packageVersion,
              hasInstallScript: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(join(sourceDir, "fixture-openclaw.mjs"), fakeOpenClaw),
    writeFile(join(sourceDir, "fixture-postinstall.mjs"), fixturePostinstall),
    writeFile(join(sourceDir, "fixture-build.mjs"), fixtureBuild),
    writeFile(
      join(sourceDir, "scripts", "run-final-fast-demo.sh"),
      fixtureFastDemo,
    ),
    writeFile(join(fakeBin, "npm"), npmWrapper),
    writeFile(callerConfig, "caller-config-sentinel\n"),
    writeFile(join(callerHome, "sentinel.txt"), "caller-home-sentinel\n"),
    writeFile(join(callerState, "sentinel.txt"), "caller-state-sentinel\n"),
    writeFile(
      join(callerLobsterState, "sentinel.txt"),
      "caller-lobster-state-sentinel\n",
    ),
  ]);
  await chmod(join(fakeBin, "npm"), 0o755);

  runGit(sourceDir, ["init", "--quiet"]);
  runGit(sourceDir, ["config", "user.name", "Guardian Test"]);
  runGit(sourceDir, ["config", "user.email", "guardian@example.test"]);
  runGit(sourceDir, ["add", "."]);
  runGit(sourceDir, ["commit", "--quiet", "-m", "release fixture"]);
  const commit = runGit(sourceDir, ["rev-parse", "HEAD"]);
  if (tagKind === "annotated") {
    runGit(sourceDir, ["tag", "-a", releaseRef, "-m", "release fixture"]);
  } else {
    runGit(sourceDir, ["tag", releaseRef]);
  }

  runGit(root, ["init", "--bare", "--quiet", remoteDir]);
  runGit(sourceDir, ["remote", "add", "origin", remoteDir]);
  runGit(sourceDir, [
    "push",
    "--quiet",
    "origin",
    "HEAD:refs/heads/main",
    `refs/tags/${releaseRef}`,
  ]);

  return {
    root,
    sourceDir,
    remoteDir,
    remoteUrl: pathToFileURL(remoteDir).href,
    fakeBin,
    callerConfig,
    callerHome,
    callerState,
    callerLobsterState,
    npmLog,
    cliLog,
    postinstallMarker,
    buildMarker,
    demoMarker,
    packageVersion,
    releaseRef,
    commit,
  };
}

function runProof(fixture, releaseRef = fixture.releaseRef, extraEnv = {}) {
  return spawnSync("bash", [proofScript, releaseRef, fixture.remoteUrl], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      PATH: `${fixture.fakeBin}:${process.env.PATH}`,
      npm_config_cache: join(fixture.root, "proof-npm-cache"),
      GUARDIAN_TEST_REAL_NPM: realNpm,
      GUARDIAN_TEST_NPM_LOG: fixture.npmLog,
      GUARDIAN_TEST_CLI_LOG: fixture.cliLog,
      GUARDIAN_TEST_POSTINSTALL_MARKER: fixture.postinstallMarker,
      GUARDIAN_TEST_BUILD_MARKER: fixture.buildMarker,
      GUARDIAN_TEST_DEMO_MARKER: fixture.demoMarker,
      GUARDIAN_TEST_PLUGIN_VERSION: fixture.packageVersion,
      OPENCLAW_CONFIG_PATH: fixture.callerConfig,
      OPENCLAW_PROFILE: "caller-profile",
      OPENCLAW_HOME: fixture.callerHome,
      OPENCLAW_STATE_DIR: fixture.callerState,
      LOBSTER_STATE_DIR: fixture.callerLobsterState,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      ...extraEnv,
    },
  });
}

async function readOptional(path) {
  return readFile(path, "utf8").catch(() => "");
}

async function parseJsonLines(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function moveReleaseTag(fixture) {
  await writeFile(join(fixture.sourceDir, "moving-tag.txt"), "new commit\n");
  runGit(fixture.sourceDir, ["add", "moving-tag.txt"]);
  runGit(fixture.sourceDir, ["commit", "--quiet", "-m", "move release tag"]);
  const movedCommit = runGit(fixture.sourceDir, ["rev-parse", "HEAD"]);
  runGit(fixture.sourceDir, ["tag", "--force", fixture.releaseRef]);
  runGit(fixture.sourceDir, [
    "push",
    "--quiet",
    "--force",
    "origin",
    `refs/tags/${fixture.releaseRef}`,
  ]);
  return movedCommit;
}

describe("fresh source release proof", () => {
  it.each(["annotated", "lightweight"])(
    "accepts an exact %s release tag through npm lifecycle and linked installs",
    async (tagKind) => {
      const fixture = await createFixture({ tagKind });

      const result = runProof(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schemaVersion: 1,
        ok: true,
        proof: "dataops-guardian-source-release",
        releaseRef: fixture.releaseRef,
        sourceRevision: fixture.commit,
        guardianVersion: fixture.packageVersion,
        openclawVersion: "2026.6.34",
        lobsterVersion: "2026.6.34",
        runtimeRegistration: {
          tools: 5,
          hooks: 5,
          lobsterApprovalRestart: true,
        },
      });

      const npmInvocations = (await readFile(fixture.npmLog, "utf8"))
        .trim()
        .split("\n");
      expect(npmInvocations).toEqual([
        "ci\t--no-audit\t--no-fund",
        "run\tbuild",
      ]);
      expect(npmInvocations.join(" ")).not.toContain("--ignore-scripts");
      expect(await readFile(fixture.buildMarker, "utf8")).toBe("built\n");
      expect(await readFile(fixture.demoMarker, "utf8")).toBe(
        `${fixture.commit}\n`,
      );

      const postinstall = JSON.parse(
        await readFile(fixture.postinstallMarker, "utf8"),
      );
      expect(postinstall).toEqual({
        stateDir: expect.stringMatching(
          /^\/tmp\/guardian-source-release\.[^/]+\/openclaw-state$/,
        ),
        lobsterStateDir: expect.stringMatching(
          /^\/tmp\/guardian-source-release\.[^/]+\/lobster-state$/,
        ),
        configPath: null,
        profile: null,
        home: null,
      });

      const cliInvocations = await parseJsonLines(fixture.cliLog);
      expect(cliInvocations.map(({ args }) => args)).toEqual([
        [
          "plugins",
          "install",
          "--link",
          expect.stringMatching(
            /^\/tmp\/guardian-source-release\.[^/]+\/repository$/,
          ),
        ],
        ["plugins", "enable", "dataops-guardian"],
        [
          "plugins",
          "install",
          "--link",
          expect.stringMatching(
            /^\/tmp\/guardian-source-release\.[^/]+\/repository\/node_modules\/@openclaw\/lobster$/,
          ),
        ],
        ["plugins", "enable", "lobster"],
        ["config", "set", "--batch-json", expect.any(String)],
        ["plugins", "inspect", "dataops-guardian", "--runtime", "--json"],
        ["plugins", "inspect", "lobster", "--runtime", "--json"],
      ]);
      for (const invocation of cliInvocations) {
        expect(invocation.stateDir).toBe(postinstall.stateDir);
        expect(invocation.lobsterStateDir).toBe(postinstall.lobsterStateDir);
        expect(invocation.disableBundled).toBe("1");
        expect(invocation.OPENCLAW_CONFIG_PATH).toBeNull();
        expect(invocation.OPENCLAW_PROFILE).toBeNull();
        expect(invocation.OPENCLAW_HOME).toBeNull();
      }
      const batch = JSON.parse(cliInvocations[4].args[3]);
      expect(batch.map(({ path }) => path)).not.toContain("plugins.load.paths");
      expect(batch.map(({ path }) => path)).not.toContain("tools.alsoAllow");
      expect(
        batch.find(
          ({ path }) =>
            path ===
            "plugins.entries.dataops-guardian.config.requireToolsGateMode",
        )?.value,
      ).toBe("on_guardian_tool");
      expect(
        batch.find(
          ({ path }) =>
            path ===
            "plugins.entries.dataops-guardian.config.lobsterToolPolicyMode",
        )?.value,
      ).toBe("incident_workflow_only");
      expect(batch.find(({ path }) => path === "tools.allow")?.value).toEqual([
        "guardian_inspect_metric_snapshot",
        "guardian_propose_remediation",
        "guardian_query_prometheus",
        "guardian_rollback_deployment",
        "guardian_verify_deployment_recovery",
        "lobster",
      ]);

      expect(await readFile(fixture.callerConfig, "utf8")).toBe(
        "caller-config-sentinel\n",
      );
      expect(await readdir(fixture.callerHome)).toEqual(["sentinel.txt"]);
      expect(await readdir(fixture.callerState)).toEqual(["sentinel.txt"]);
      expect(await readdir(fixture.callerLobsterState)).toEqual([
        "sentinel.txt",
      ]);
    },
  );

  it("rejects a missing release tag before installing dependencies", async () => {
    const fixture = await createFixture();

    const result = runProof(fixture, "v9.9.9");

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("remote release tag does not exist: v9.9.9");
    expect(result.stdout).toBe("");
    expect(await readOptional(fixture.npmLog)).toBe("");
    expect(await readOptional(fixture.cliLog)).toBe("");
  });

  it("rejects a tag that moves after remote resolution", async () => {
    const fixture = await createFixture();
    const staleCommit = fixture.commit;
    const movedCommit = await moveReleaseTag(fixture);
    expect(movedCommit).not.toBe(staleCommit);
    const gitWrapper = join(fixture.fakeBin, "git");
    await writeFile(
      gitWrapper,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "ls-remote" ]]; then
  printf '%s\\trefs/tags/v0.3.0\\n' "$GUARDIAN_TEST_STALE_COMMIT"
  exit 0
fi
exec "$GUARDIAN_TEST_REAL_GIT" "$@"
`,
    );
    await chmod(gitWrapper, 0o755);

    const result = runProof(fixture, fixture.releaseRef, {
      GUARDIAN_TEST_REAL_GIT: realGit,
      GUARDIAN_TEST_STALE_COMMIT: staleCommit,
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "fresh release checkout does not match the resolved tag commit",
    );
    expect(await readOptional(fixture.npmLog)).toBe("");
    expect(await readOptional(fixture.cliLog)).toBe("");
  });

  it("rejects a package version that disagrees with the tag", async () => {
    const fixture = await createFixture({ packageVersion: "0.3.1" });

    const result = runProof(fixture);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("release tag and package version disagree");
    expect(await readOptional(fixture.npmLog)).toBe("");
    expect(await readOptional(fixture.cliLog)).toBe("");
  });
});
