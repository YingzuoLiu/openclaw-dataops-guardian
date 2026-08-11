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

import {
  EXPECTED_LOBSTER_VERSION,
  EXPECTED_NODE_VERSION,
  EXPECTED_OPENCLAW_VERSION,
  preflightRole,
  verifyImageContract,
  writeImageMetadata,
} from "./runtime-contract.mjs";

const temporaryRoots = [];
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createImageFixture() {
  const root = await mkdtemp(join(tmpdir(), "guardian-image-contract-test-"));
  temporaryRoots.push(root);
  const guardianRoot = join(root, "guardian");
  const openclawRoot = join(root, "openclaw");
  const requiredFiles = [
    "LICENSE",
    "container/entrypoint.sh",
    "container/openclaw.container.example.json",
    "container/runtime-contract.mjs",
    "dist/alertmanager/http-bridge/run.js",
    "dist/index.js",
    "dist/runtime/lobster-approval-payload.js",
    "openclaw.plugin.json",
    "scripts/remediation-step.mjs",
    "workflows/incident-remediation.lobster",
  ];
  for (const path of requiredFiles) {
    const absolute = join(guardianRoot, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, "fixture\n");
  }
  await Promise.all([
    writeJson(join(guardianRoot, "package.json"), {
      name: "openclaw-dataops-guardian",
      version: "0.3.0",
    }),
    writeJson(join(openclawRoot, "package.json"), {
      name: "openclaw",
      version: EXPECTED_OPENCLAW_VERSION,
    }),
    writeJson(
      join(
        guardianRoot,
        "node_modules",
        "@openclaw",
        "lobster",
        "package.json",
      ),
      { name: "@openclaw/lobster", version: EXPECTED_LOBSTER_VERSION },
    ),
  ]);
  await mkdir(join(guardianRoot, "node_modules"), { recursive: true });
  await symlink(openclawRoot, join(guardianRoot, "node_modules", "openclaw"));
  await writeImageMetadata({
    guardianRoot,
    openclawRoot,
    guardianVersion: "0.3.0",
    sourceRevision: "a".repeat(40),
  });
  return { root, guardianRoot, openclawRoot };
}

function gatewayConfig(guardianRoot) {
  return {
    gateway: { mode: "local", auth: { mode: "token" } },
    plugins: {
      allow: ["dataops-guardian", "lobster"],
      load: {
        paths: [
          guardianRoot,
          join(guardianRoot, "node_modules", "@openclaw", "lobster"),
        ],
      },
      entries: {
        "dataops-guardian": {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: {
            requireToolsGateMode: "on_guardian_tool",
            lobsterToolPolicyMode: "incident_workflow_only",
          },
        },
        lobster: { enabled: true },
      },
    },
    tools: {
      allow: [
        "guardian_query_prometheus",
        "guardian_inspect_metric_snapshot",
        "guardian_propose_remediation",
        "guardian_rollback_deployment",
        "guardian_verify_deployment_recovery",
        "lobster",
      ],
    },
  };
}

describe("container runtime contract", () => {
  it("accepts an immutable two-role image inventory using the host OpenClaw peer", async () => {
    const fixture = await createImageFixture();
    const result = await verifyImageContract({
      guardianRoot: fixture.guardianRoot,
      openclawRoot: fixture.openclawRoot,
    });

    expect(result.metadata).toMatchObject({
      guardianVersion: "0.3.0",
      sourceRevision: "a".repeat(40),
      roles: ["bridge", "gateway"],
      lobsterVersion: EXPECTED_LOBSTER_VERSION,
      nodeVersion: EXPECTED_NODE_VERSION,
      openclaw: { version: EXPECTED_OPENCLAW_VERSION },
    });
  });

  it("rejects compiled tests and source maps from the owned runtime tree", async () => {
    const fixture = await createImageFixture();
    await writeFile(join(fixture.guardianRoot, "dist", "leaked.test.js"), "bad\n");
    await expect(
      verifyImageContract({
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
      }),
    ).rejects.toThrow("compiled test");

    await rm(join(fixture.guardianRoot, "dist", "leaked.test.js"));
    await writeFile(join(fixture.guardianRoot, "dist", "index.js.map"), "{}\n");
    await expect(
      verifyImageContract({
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
      }),
    ).rejects.toThrow("source map");
  });

  it("requires the gateway token, strict config, load paths, and writable state", async () => {
    const fixture = await createImageFixture();
    const configPath = join(fixture.root, "openclaw.json");
    const stateDir = join(fixture.root, "gateway-state");
    await writeJson(configPath, gatewayConfig(fixture.guardianRoot));

    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_STATE_DIR: stateDir,
          LOBSTER_STATE_DIR: join(stateDir, "lobster-state"),
        },
      }),
    ).resolves.toBeUndefined();

    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: stateDir,
          LOBSTER_STATE_DIR: join(stateDir, "lobster-state"),
        },
      }),
    ).rejects.toThrow("OPENCLAW_GATEWAY_TOKEN is required");

    await writeFile(configPath, "{ comments: are-not-json }\n");
    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_STATE_DIR: stateDir,
          LOBSTER_STATE_DIR: join(stateDir, "lobster-state"),
        },
      }),
    ).rejects.toThrow("must be strict JSON");
  });

  it("restricts the container profile to Guardian and Lobster tools", async () => {
    const fixture = await createImageFixture();
    const configPath = join(fixture.root, "openclaw.json");
    const stateDir = join(fixture.root, "gateway-state");
    const config = gatewayConfig(fixture.guardianRoot);
    config.tools.allow.push("exec");
    await writeJson(configPath, config);

    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_STATE_DIR: stateDir,
          LOBSTER_STATE_DIR: join(stateDir, "lobster-state"),
        },
      }),
    ).rejects.toThrow("tools.allow must contain only");
  });

  it("rejects additional plugin roots and plugin allowlist entries", async () => {
    const fixture = await createImageFixture();
    const configPath = join(fixture.root, "openclaw.json");
    const stateDir = join(fixture.root, "gateway-state");
    const env = {
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      OPENCLAW_STATE_DIR: stateDir,
      LOBSTER_STATE_DIR: join(stateDir, "lobster-state"),
    };
    const config = gatewayConfig(fixture.guardianRoot);
    config.plugins.allow.push("unreviewed-plugin");
    await writeJson(configPath, config);
    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env,
      }),
    ).rejects.toThrow("plugins.allow must contain only");

    config.plugins.allow.pop();
    config.plugins.load.paths.push(join(fixture.root, "unreviewed-plugin"));
    await writeJson(configPath, config);
    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env,
      }),
    ).rejects.toThrow("plugins.load.paths must contain only");
  });

  it("requires durable Lobster resume state for the Gateway role", async () => {
    const fixture = await createImageFixture();
    const configPath = join(fixture.root, "openclaw.json");
    await writeJson(configPath, gatewayConfig(fixture.guardianRoot));
    await expect(
      preflightRole("gateway", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_GATEWAY_TOKEN: "gateway-token",
          OPENCLAW_STATE_DIR: join(fixture.root, "gateway-state"),
        },
      }),
    ).rejects.toThrow("LOBSTER_STATE_DIR is required");
  });

  it("requires all Bridge secrets, a credential-free WebSocket URL, and state", async () => {
    const fixture = await createImageFixture();
    const base = {
      ALERTMANAGER_BRIDGE_TOKEN: "alert-token",
      OPENCLAW_GATEWAY_URL: "ws://127.0.0.1:18789",
      OPENCLAW_GATEWAY_TOKEN: "gateway-token",
      ALERTMANAGER_BRIDGE_STATE_DIR: join(fixture.root, "bridge-state"),
    };

    await expect(
      preflightRole("bridge", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: base,
      }),
    ).resolves.toBeUndefined();

    for (const name of Object.keys(base)) {
      const env = { ...base };
      delete env[name];
      await expect(
        preflightRole("bridge", {
          guardianRoot: fixture.guardianRoot,
          openclawRoot: fixture.openclawRoot,
          env,
        }),
      ).rejects.toThrow(name);
    }

    await expect(
      preflightRole("bridge", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          ...base,
          OPENCLAW_GATEWAY_URL: "ws://user:password@127.0.0.1:18789",
        },
      }),
    ).rejects.toThrow("must not embed credentials");

    await expect(
      preflightRole("bridge", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          ...base,
          OPENCLAW_GATEWAY_URL: "ws://gateway.example.test:18789",
        },
      }),
    ).rejects.toThrow("local backend protocol");

    await expect(
      preflightRole("bridge", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {
          ...base,
          ALERTMANAGER_BRIDGE_TOKEN: "reused-token",
          OPENCLAW_GATEWAY_TOKEN: "reused-token",
        },
      }),
    ).rejects.toThrow("must be distinct");
  });

  it("rejects unknown runtime roles", async () => {
    const fixture = await createImageFixture();
    await expect(
      preflightRole("operator", {
        guardianRoot: fixture.guardianRoot,
        openclawRoot: fixture.openclawRoot,
        env: {},
      }),
    ).rejects.toThrow("unsupported role");
  });
});

describe("Dockerfile boundary", () => {
  it("pins the upstream digest, rebuilds source, disables the shared healthcheck, and keeps tini", async () => {
    const dockerfile = await readFile(
      join(repositoryRoot, "container", "Dockerfile"),
      "utf8",
    );
    expect(dockerfile).toContain(
      "ghcr.io/openclaw/openclaw:2026.6.34@sha256:47d342bafe83bd3b2dca6f1d8d8b608ba7b542a1952564960648943346206759",
    );
    expect(dockerfile).toContain("npm run build:runtime");
    expect(dockerfile).toContain('test "$(node --version)" = "v24.16.0"');
    expect(dockerfile).toContain(
      "install -d -o node -g node -m 0755 /build/dataops-guardian",
    );
    expect(dockerfile).toContain(
      "install -d -o node -g node -m 0755 /build/dataops-guardian-runtime",
    );
    expect(dockerfile).toContain(
      "COPY --from=guardian-build --chown=root:root",
    );
    expect(dockerfile).toContain("chmod -R a-w /opt/dataops-guardian");
    expect(dockerfile).toContain("HEALTHCHECK NONE");
    expect(dockerfile).toContain(
      'ENTRYPOINT ["tini", "-s", "--", "/opt/dataops-guardian/container/entrypoint.sh"]',
    );
    expect(dockerfile).toContain("USER node\nENTRYPOINT");
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/m);
    expect(dockerfile).not.toContain("plugins install");
  });

  it("uses an allowlisted Docker context", async () => {
    const ignore = await readFile(join(repositoryRoot, ".dockerignore"), "utf8");
    expect(ignore.split("\n")[0]).toBe("**");
    expect(ignore).not.toContain("!.git");
    expect(ignore).not.toContain("!dist/");
    expect(ignore).not.toContain("!node_modules/");
    for (const denied of [
      "**/.env",
      "**/.npmrc",
      "**/kubeconfig",
      "**/*.kubeconfig",
      "**/*.key",
      "**/*.pem",
    ]) {
      expect(ignore).toContain(denied);
    }
  });

  it("makes the missing-artifact bind fixture readable by the image user", async () => {
    const proof = await readFile(
      join(repositoryRoot, "scripts", "run-container-image-proof.sh"),
      "utf8",
    );
    expect(proof).toContain('chmod 0555 "$runtime_dir/empty-dist"');
    expect(proof).toContain(
      "timeout --foreground --signal=TERM --kill-after=5s 15s",
    );
    expect(proof).toContain("lobster.plugin?.contracts?.tools");
    expect(proof).toContain("tools.catalog");
    expect(proof).toContain("printenv OPENCLAW_GATEWAY_TOKEN");
    expect(proof).toContain("lobsterApprovalRestart");
  });

  it("keeps package, lockfile, and container runtime versions aligned", async () => {
    const [pkg, lock, runtimePackage, runtimeLock] = await Promise.all(
      [
        "package.json",
        "package-lock.json",
        "container/package.json",
        "container/package-lock.json",
      ].map(async (path) => JSON.parse(await readFile(join(repositoryRoot, path), "utf8"))),
    );
    expect(lock.packages[""].version).toBe(pkg.version);
    expect(runtimePackage.version).toBe(pkg.version);
    expect(runtimeLock.packages[""].version).toBe(pkg.version);
    expect(pkg.devDependencies.openclaw).toBe(EXPECTED_OPENCLAW_VERSION);
    expect(pkg.peerDependencies.openclaw).toBe(">=2026.6.34");
    expect(pkg.dependencies["@openclaw/lobster"]).toBe(
      EXPECTED_LOBSTER_VERSION,
    );
    expect(runtimePackage.dependencies["@openclaw/lobster"]).toBe(
      EXPECTED_LOBSTER_VERSION,
    );
  });
});
