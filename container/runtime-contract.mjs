import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const GUARDIAN_ROOT = "/opt/dataops-guardian";
export const OPENCLAW_ROOT = "/app";
export const LOBSTER_RELATIVE_ROOT = "node_modules/@openclaw/lobster";
export const EXPECTED_OPENCLAW_VERSION = "2026.6.34";
export const EXPECTED_LOBSTER_VERSION = "2026.6.34";
export const EXPECTED_NODE_VERSION = "24.16.0";
export const EXPECTED_OPENCLAW_SOURCE_REVISION =
  "5c38f996d4059ebd9080cf74dc611ec3a17f4d50";
export const EXPECTED_OPENCLAW_IMAGE =
  "ghcr.io/openclaw/openclaw:2026.6.34@sha256:47d342bafe83bd3b2dca6f1d8d8b608ba7b542a1952564960648943346206759";

const IMAGE_METADATA_FILE = "image-metadata.json";
const REQUIRED_RUNTIME_TOOLS = [
  "guardian_inspect_metric_snapshot",
  "guardian_propose_remediation",
  "guardian_query_prometheus",
  "guardian_rollback_deployment",
  "guardian_verify_deployment_recovery",
  "lobster",
];
const REQUIRED_OWNED_FILES = [
  "LICENSE",
  "container/entrypoint.sh",
  "container/openclaw.container.example.json",
  "container/runtime-contract.mjs",
  "dist/alertmanager/http-bridge/run.js",
  "dist/index.js",
  "dist/runtime/lobster-approval-payload.js",
  "openclaw.plugin.json",
  "package.json",
  "scripts/remediation-step.mjs",
  "workflows/incident-remediation.lobster",
];
const FORBIDDEN_DIRECTORY_NAMES = new Set([
  ".git",
  "docs",
  "evals",
  "spikes",
  "src",
]);

function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function readJson(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`${label} is unavailable`, { cause: error });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be strict JSON`, { cause: error });
  }
}

async function listOwnedFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      const path = relative(root, absolute).replaceAll("\\", "/");
      if (path === "node_modules" || path.startsWith("node_modules/")) {
        continue;
      }
      if (entry.isDirectory()) {
        invariant(
          !FORBIDDEN_DIRECTORY_NAMES.has(entry.name),
          `image contains forbidden Guardian directory: ${path}`,
        );
        stack.push(absolute);
        continue;
      }
      files.push(path);
    }
  }
  return files.sort();
}

function assertOwnedInventory(files) {
  for (const required of REQUIRED_OWNED_FILES) {
    invariant(files.includes(required), `image is missing Guardian artifact: ${required}`);
  }
  for (const path of files) {
    const lower = path.toLowerCase();
    invariant(!lower.endsWith(".test.js"), `image contains compiled test: ${path}`);
    invariant(!lower.endsWith(".d.ts"), `image contains declaration file: ${path}`);
    invariant(!lower.endsWith(".map"), `image contains source map: ${path}`);
    invariant(!lower.endsWith(".env"), `image contains environment file: ${path}`);
    invariant(!lower.endsWith(".npmrc"), `image contains npm config: ${path}`);
    invariant(!lower.endsWith(".key"), `image contains private-key-shaped file: ${path}`);
    invariant(!lower.endsWith(".pem"), `image contains PEM-shaped file: ${path}`);
    invariant(
      !/(^|\/)(kubeconfig|[^/]*\.kubeconfig)$/i.test(path),
      `image contains kubeconfig-shaped file: ${path}`,
    );
  }
}

function assertVersion(packageJson, expected, label) {
  invariant(
    packageJson?.version === expected,
    `${label} version mismatch (expected ${expected}, got ${String(packageJson?.version)})`,
  );
}

export async function writeImageMetadata({
  guardianRoot = GUARDIAN_ROOT,
  openclawRoot = OPENCLAW_ROOT,
  guardianVersion,
  sourceRevision,
} = {}) {
  invariant(
    typeof guardianVersion === "string" && /^\d+\.\d+\.\d+$/.test(guardianVersion),
    "Guardian image version must be an exact semantic version",
  );
  invariant(
    typeof sourceRevision === "string" && /^[0-9a-f]{40}$/.test(sourceRevision),
    "Guardian source revision must be a lowercase 40-hex commit",
  );

  const guardianPackage = await readJson(
    join(guardianRoot, "package.json"),
    "Guardian package metadata",
  );
  const openclawPackage = await readJson(
    join(openclawRoot, "package.json"),
    "OpenClaw package metadata",
  );
  const lobsterPackage = await readJson(
    join(guardianRoot, LOBSTER_RELATIVE_ROOT, "package.json"),
    "Lobster package metadata",
  );
  assertVersion(guardianPackage, guardianVersion, "Guardian");
  assertVersion(openclawPackage, EXPECTED_OPENCLAW_VERSION, "OpenClaw");
  assertVersion(lobsterPackage, EXPECTED_LOBSTER_VERSION, "Lobster");

  const metadata = {
    schemaVersion: 1,
    guardianVersion,
    sourceRevision,
    roles: ["bridge", "gateway"],
    openclaw: {
      version: EXPECTED_OPENCLAW_VERSION,
      sourceRevision: EXPECTED_OPENCLAW_SOURCE_REVISION,
      image: EXPECTED_OPENCLAW_IMAGE,
    },
    lobsterVersion: EXPECTED_LOBSTER_VERSION,
    nodeVersion: EXPECTED_NODE_VERSION,
  };
  const path = join(guardianRoot, IMAGE_METADATA_FILE);
  await writeFile(path, `${JSON.stringify(metadata, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o444,
  });
  await chmod(path, 0o444);
  return metadata;
}

export async function verifyImageContract({
  guardianRoot = GUARDIAN_ROOT,
  openclawRoot = OPENCLAW_ROOT,
  expectedOpenclawLinkTarget = openclawRoot,
} = {}) {
  const metadata = await readJson(
    join(guardianRoot, IMAGE_METADATA_FILE),
    "Guardian image metadata",
  );
  invariant(metadata?.schemaVersion === 1, "unsupported Guardian image metadata");
  invariant(
    Array.isArray(metadata.roles) &&
      metadata.roles.length === 2 &&
      metadata.roles[0] === "bridge" &&
      metadata.roles[1] === "gateway",
    "Guardian image metadata must declare exactly bridge and gateway roles",
  );
  invariant(
    /^[0-9a-f]{40}$/.test(metadata.sourceRevision),
    "Guardian image metadata has an invalid source revision",
  );
  invariant(
    metadata.openclaw?.version === EXPECTED_OPENCLAW_VERSION &&
      metadata.openclaw?.sourceRevision === EXPECTED_OPENCLAW_SOURCE_REVISION &&
      metadata.openclaw?.image === EXPECTED_OPENCLAW_IMAGE,
    "Guardian image metadata has an invalid OpenClaw base contract",
  );
  invariant(
    metadata.lobsterVersion === EXPECTED_LOBSTER_VERSION,
    "Guardian image metadata has an invalid Lobster version",
  );
  invariant(
    metadata.nodeVersion === EXPECTED_NODE_VERSION,
    "Guardian image metadata has an invalid Node version",
  );

  const [guardianPackage, openclawPackage, lobsterPackage] = await Promise.all([
    readJson(join(guardianRoot, "package.json"), "Guardian package metadata"),
    readJson(join(openclawRoot, "package.json"), "OpenClaw package metadata"),
    readJson(
      join(guardianRoot, LOBSTER_RELATIVE_ROOT, "package.json"),
      "Lobster package metadata",
    ),
  ]);
  assertVersion(guardianPackage, metadata.guardianVersion, "Guardian");
  assertVersion(openclawPackage, EXPECTED_OPENCLAW_VERSION, "OpenClaw");
  assertVersion(lobsterPackage, EXPECTED_LOBSTER_VERSION, "Lobster");

  const openclawLink = join(guardianRoot, "node_modules", "openclaw");
  const linkStat = await lstat(openclawLink);
  invariant(linkStat.isSymbolicLink(), "Guardian must use the host OpenClaw as a peer");
  invariant(
    (await realpath(openclawLink)) === (await realpath(expectedOpenclawLinkTarget)),
    "Guardian OpenClaw peer link does not target the host runtime",
  );

  const ownedFiles = await listOwnedFiles(guardianRoot);
  assertOwnedInventory(ownedFiles);
  return { metadata, ownedFiles };
}

export async function verifyImmutableGuardianTree({
  guardianRoot = GUARDIAN_ROOT,
} = {}) {
  const stack = [guardianRoot];
  let entryCount = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const currentStat = await lstat(current);
    entryCount += 1;
    invariant(
      currentStat.uid === 0 && currentStat.gid === 0,
      `Guardian runtime entry is not root-owned: ${relative(guardianRoot, current) || "."}`,
    );
    if (!currentStat.isSymbolicLink()) {
      invariant(
        (currentStat.mode & 0o022) === 0,
        `Guardian runtime entry is group/other-writable: ${relative(guardianRoot, current) || "."}`,
      );
    }
    if (!currentStat.isDirectory()) {
      continue;
    }
    for (const entry of await readdir(current, { withFileTypes: true })) {
      stack.push(join(current, entry.name));
    }
  }
  return { entryCount };
}

function requireNonEmptyEnv(env, name) {
  const value = env[name];
  invariant(
    typeof value === "string" && value.trim().length > 0,
    `${name} is required`,
  );
  return value.trim();
}

async function assertDurableDirectory(path, label) {
  invariant(isAbsolute(path), `${label} must be an absolute path`);
  await mkdir(path, { recursive: true });
  const probePath = join(
    path,
    `.guardian-container-write-probe-${process.pid}-${Date.now()}`,
  );
  let handle;
  try {
    handle = await open(probePath, "wx", 0o600);
    await handle.writeFile("guardian-container-write-probe\n", "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(probePath).catch((error) => {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

function includesExactly(values, required) {
  return (
    Array.isArray(values) &&
    values.length === required.length &&
    [...values].sort().every((value, index) => value === [...required].sort()[index])
  );
}

async function verifyGatewayConfig(path, guardianRoot) {
  invariant(isAbsolute(path), "OPENCLAW_CONFIG_PATH must be an absolute path");
  await access(path, fsConstants.R_OK);
  const config = await readJson(path, "OpenClaw container configuration");
  const lobsterRoot = join(guardianRoot, LOBSTER_RELATIVE_ROOT);
  invariant(config.gateway?.mode === "local", "gateway.mode must be local");
  invariant(config.gateway?.auth?.mode === "token", "gateway.auth.mode must be token");
  invariant(
    includesExactly(config.plugins?.load?.paths, [guardianRoot, lobsterRoot]),
    "plugins.load.paths must contain only the baked Guardian and Lobster roots",
  );
  invariant(
    includesExactly(config.plugins?.allow, ["dataops-guardian", "lobster"]),
    "plugins.allow must contain only dataops-guardian and lobster",
  );
  invariant(
    config.plugins?.entries?.["dataops-guardian"]?.enabled === true,
    "dataops-guardian must be enabled",
  );
  invariant(
    config.plugins?.entries?.["dataops-guardian"]?.hooks
      ?.allowConversationAccess === true,
    "Guardian conversation hooks must be explicitly allowed",
  );
  invariant(
    config.plugins?.entries?.["dataops-guardian"]?.config
      ?.requireToolsGateMode === "on_guardian_tool",
    "Guardian response gate must use on_guardian_tool mode",
  );
  invariant(
    config.plugins?.entries?.["dataops-guardian"]?.config
      ?.lobsterToolPolicyMode === "incident_workflow_only",
    "Guardian Lobster policy must bind the immutable incident workflow",
  );
  invariant(
    config.plugins?.entries?.lobster?.enabled === true,
    "Lobster must be enabled",
  );
  invariant(
    includesExactly(config.tools?.allow, REQUIRED_RUNTIME_TOOLS),
    "tools.allow must contain only the five Guardian tools and lobster",
  );
  invariant(
    config.tools?.alsoAllow === undefined,
    "tools.alsoAllow must be omitted when restrictive tools.allow is set",
  );
}

export async function preflightRole(
  role,
  { env = process.env, guardianRoot = GUARDIAN_ROOT, openclawRoot = OPENCLAW_ROOT } = {},
) {
  invariant(role === "gateway" || role === "bridge", `unsupported role: ${String(role)}`);
  await verifyImageContract({ guardianRoot, openclawRoot });

  if (role === "gateway") {
    const configPath = requireNonEmptyEnv(env, "OPENCLAW_CONFIG_PATH");
    requireNonEmptyEnv(env, "OPENCLAW_GATEWAY_TOKEN");
    const stateDir = requireNonEmptyEnv(env, "OPENCLAW_STATE_DIR");
    const lobsterStateDir = requireNonEmptyEnv(env, "LOBSTER_STATE_DIR");
    await verifyGatewayConfig(configPath, guardianRoot);
    await assertDurableDirectory(stateDir, "OPENCLAW_STATE_DIR");
    await assertDurableDirectory(lobsterStateDir, "LOBSTER_STATE_DIR");
    return;
  }

  const bridgeToken = requireNonEmptyEnv(env, "ALERTMANAGER_BRIDGE_TOKEN");
  const gatewayUrl = requireNonEmptyEnv(env, "OPENCLAW_GATEWAY_URL");
  const gatewayToken = requireNonEmptyEnv(env, "OPENCLAW_GATEWAY_TOKEN");
  invariant(
    bridgeToken !== gatewayToken,
    "ALERTMANAGER_BRIDGE_TOKEN and OPENCLAW_GATEWAY_TOKEN must be distinct",
  );
  const stateDir = requireNonEmptyEnv(env, "ALERTMANAGER_BRIDGE_STATE_DIR");
  let parsedGatewayUrl;
  try {
    parsedGatewayUrl = new URL(gatewayUrl);
  } catch (error) {
    throw new Error("OPENCLAW_GATEWAY_URL must be a valid ws:// or wss:// URL", {
      cause: error,
    });
  }
  invariant(
    parsedGatewayUrl.protocol === "ws:" || parsedGatewayUrl.protocol === "wss:",
    "OPENCLAW_GATEWAY_URL must use ws:// or wss://",
  );
  invariant(
    parsedGatewayUrl.username === "" && parsedGatewayUrl.password === "",
    "OPENCLAW_GATEWAY_URL must not embed credentials",
  );
  invariant(
    parsedGatewayUrl.hostname === "127.0.0.1" ||
      parsedGatewayUrl.hostname === "[::1]",
    "OPENCLAW_GATEWAY_URL must target 127.0.0.1 or [::1] for the local backend protocol",
  );
  invariant(
    parsedGatewayUrl.pathname === "/" &&
      parsedGatewayUrl.search === "" &&
      parsedGatewayUrl.hash === "",
    "OPENCLAW_GATEWAY_URL must not include a path, query, or fragment",
  );
  await assertDurableDirectory(stateDir, "ALERTMANAGER_BRIDGE_STATE_DIR");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "write-metadata") {
    const [guardianVersion, sourceRevision] = args;
    invariant(
      process.version === `v${EXPECTED_NODE_VERSION}`,
      `image Node version mismatch (expected v${EXPECTED_NODE_VERSION}, got ${process.version})`,
    );
    await writeImageMetadata({ guardianVersion, sourceRevision });
    return;
  }
  if (command === "verify-image") {
    await verifyImageContract();
    return;
  }
  if (command === "preflight") {
    await preflightRole(args[0]);
    return;
  }
  if (command === "report") {
    invariant(
      process.version === `v${EXPECTED_NODE_VERSION}`,
      `image Node version mismatch (expected v${EXPECTED_NODE_VERSION}, got ${process.version})`,
    );
    const { metadata } = await verifyImageContract();
    const immutableRuntime = await verifyImmutableGuardianTree();
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        uid: typeof process.getuid === "function" ? process.getuid() : null,
        metadata,
        immutableRuntime,
      })}\n`,
    );
    return;
  }
  throw new Error(`unsupported runtime-contract command: ${String(command)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
