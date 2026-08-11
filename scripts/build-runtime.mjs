import { spawnSync } from "node:child_process";
import { readdirSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outputRoot = join(root, "dist-runtime");
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

rmSync(outputRoot, { recursive: true, force: true });

const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.runtime.json"], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const forbidden = [];
const stack = [outputRoot];
while (stack.length > 0) {
  const current = stack.pop();
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) {
      stack.push(absolute);
      continue;
    }
    const path = relative(outputRoot, absolute).replaceAll("\\", "/");
    if (
      path.endsWith(".test.js") ||
      path.endsWith(".d.ts") ||
      path.endsWith(".map")
    ) {
      forbidden.push(path);
    }
  }
}

if (forbidden.length > 0) {
  throw new Error(
    `runtime build contains forbidden artifacts: ${forbidden.sort().join(", ")}`,
  );
}

for (const required of [
  "index.js",
  "alertmanager/http-bridge/run.js",
  "runtime/lobster-approval-payload.js",
]) {
  const found = readdirSync(join(outputRoot, dirname(required))).includes(
    required.split("/").at(-1),
  );
  if (!found) {
    throw new Error(`runtime build is missing required artifact: ${required}`);
  }
}
