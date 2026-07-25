import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { platform, release, arch } from "node:os";
import { spawnSync } from "node:child_process";

function commandResult(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 15_000,
  });
  return {
    available: !result.error && result.status !== null,
    exitCode: result.status,
    version: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(0, 300),
  };
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const docker = commandResult("docker", ["version", "--format", "{{json .}}"]);
const kind = commandResult("kind", ["version"]);
const kubectl = commandResult("kubectl", ["version", "--client=true"]);
const runtimeSockets = Object.fromEntries(
  await Promise.all(
    [
      "/var/run/docker.sock",
      "/run/docker.sock",
      "/run/containerd/containerd.sock",
      "/run/podman/podman.sock",
    ].map(async (path) => [path, await exists(path)]),
  ),
);

const missing = [];
if (!docker.available) {
  missing.push("docker command");
} else if (docker.exitCode !== 0) {
  missing.push("reachable Docker daemon");
}
if (!kind.available || kind.exitCode !== 0) {
  missing.push("kind command");
}
if (!kubectl.available || kubectl.exitCode !== 0) {
  missing.push("kubectl command");
}

const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  ok: missing.length === 0,
  environment: {
    platform: platform(),
    release: release(),
    arch: arch(),
    nodeVersion: process.version,
  },
  docker,
  kind,
  kubectl,
  runtimeSockets,
  missing,
};

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (!result.ok) {
  process.exitCode = 2;
}
