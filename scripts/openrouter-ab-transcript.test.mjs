import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveTrialTranscriptPath } from "./openrouter-ab-transcript.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

async function createSessionsDir() {
  const root = await mkdtemp(join(tmpdir(), "guardian-ab-transcript-"));
  temporaryDirectories.push(root);
  const sessionsDir = join(root, "agents", "main", "sessions");
  await mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

describe("resolveTrialTranscriptPath", () => {
  it("selects the requested trial transcript when a host run creates another one", async () => {
    const sessionsDir = await createSessionsDir();
    const trialKey = "agent:main:dataops-guardian-ab-trial";
    await writeFile(
      join(sessionsDir, "sessions.json"),
      JSON.stringify({
        [trialKey]: { sessionId: "trial-session" },
        "agent:main:host-recovery": { sessionId: "host-session" },
      }),
    );
    await writeFile(join(sessionsDir, "trial-session.jsonl"), "trial\n");
    await writeFile(join(sessionsDir, "host-session.jsonl"), "host\n");

    await expect(
      resolveTrialTranscriptPath(sessionsDir, trialKey),
    ).resolves.toBe(join(sessionsDir, "trial-session.jsonl"));
  });

  it("fails clearly when the trial session is absent from the index", async () => {
    const sessionsDir = await createSessionsDir();
    await writeFile(join(sessionsDir, "sessions.json"), "{}\n");

    await expect(
      resolveTrialTranscriptPath(sessionsDir, "agent:main:missing"),
    ).rejects.toThrow("no transcript mapping found");
  });
});
