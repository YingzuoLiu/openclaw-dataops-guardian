import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function resolveTrialTranscriptPath(sessionsDir, sessionKey) {
  if (typeof sessionKey !== "string" || sessionKey.length === 0) {
    throw new Error("trial RPC did not provide a session key");
  }

  const indexPath = join(sessionsDir, "sessions.json");
  const sessionIndex = JSON.parse(await readFile(indexPath, "utf8"));
  const sessionId = sessionIndex?.[sessionKey]?.sessionId;
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new Error(`no transcript mapping found for trial session ${sessionKey}`);
  }
  if (sessionId.includes("/") || sessionId.includes("\\")) {
    throw new Error(`invalid transcript session id for trial session ${sessionKey}`);
  }

  const transcriptPath = join(sessionsDir, `${sessionId}.jsonl`);
  try {
    await access(transcriptPath);
  } catch {
    throw new Error(`mapped transcript does not exist for trial session ${sessionKey}`);
  }
  return transcriptPath;
}
