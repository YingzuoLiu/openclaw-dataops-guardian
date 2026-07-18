import { readFile, writeFile } from "node:fs/promises";

const action = process.argv[2];
const markerPath = process.env.OPENCLAW_PROOF3_MARKER;

if (!markerPath) {
  throw new Error("OPENCLAW_PROOF3_MARKER is required");
}

if (!new Set(["prepare", "apply"]).has(action)) {
  throw new Error("usage: node scripts/proof3-step.mjs <prepare|apply>");
}

const marker = JSON.parse(await readFile(markerPath, "utf8"));

if (action === "prepare") {
  marker.prepareCount += 1;
}
if (action === "apply") {
  marker.applyCount += 1;
}

await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ action, marker })}\n`);
