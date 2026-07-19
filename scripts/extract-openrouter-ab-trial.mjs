import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const [stateDir, rpcPath, gatewayPath, arm, summaryPath, rawPath, auditPath] =
  process.argv.slice(2);
if (
  !stateDir ||
  !rpcPath ||
  !gatewayPath ||
  !arm ||
  !summaryPath ||
  !rawPath ||
  !auditPath
) {
  throw new Error(
    "usage: extract-openrouter-ab-trial <state-dir> <rpc.json> <gateway.log> <arm> <summary.json> <raw.json> <hook-audit.jsonl>",
  );
}

const rpc = JSON.parse(await readFile(rpcPath, "utf8"));
const sessionsDir = join(stateDir, "agents", "main", "sessions");
const transcriptNames = (await readdir(sessionsDir)).filter(
  (name) =>
    name.endsWith(".jsonl") &&
    !name.endsWith(".trajectory.jsonl") &&
    name !== "sessions.jsonl",
);
if (transcriptNames.length !== 1) {
  throw new Error(
    `expected exactly one isolated transcript, found ${transcriptNames.length}`,
  );
}

const transcriptPath = join(sessionsDir, transcriptNames[0]);
const entries = (await readFile(transcriptPath, "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const messages = entries
  .filter((entry) => entry.type === "message" && entry.message)
  .map((entry) => ({ id: entry.id, timestamp: entry.timestamp, ...entry.message }));
const assistants = messages.filter((message) => message.role === "assistant");
const toolResults = messages.filter((message) => message.role === "toolResult");
const toolCalls = assistants.flatMap((message) =>
  (Array.isArray(message.content) ? message.content : [])
    .filter((part) => part?.type === "toolCall")
    .map((part) => ({
      id: part.id,
      name: part.name,
      arguments: part.arguments,
      responseId: message.responseId ?? null,
    })),
);
const successfulTools = new Set(
  toolResults
    .filter((message) => message.isError !== true)
    .map((message) => message.toolName),
);
const requiredToolsSucceeded = rpc.requiredTools.every((tool) =>
  successfulTools.has(tool),
);

function textOf(message) {
  if (typeof message?.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message?.content)) {
    return "";
  }
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const finalAssistant = assistants
  .toReversed()
  .find((message) => textOf(message).length > 0);
const finalText = textOf(finalAssistant);
const reportsBlocked =
  /\b(blocked|cannot verify|unable to verify|insufficient evidence|no (?:current|fresh) evidence)\b|无法验证|证据不足/i.test(
    finalText,
  );
const unsupportedConclusionReleased =
  finalText.length > 0 && !requiredToolsSucceeded && !reportsBlocked;

const usage = assistants.reduce(
  (total, message) => {
    const current = message.usage ?? {};
    total.inputTokens += Number(current.input ?? 0);
    total.outputTokens += Number(current.output ?? 0);
    total.cacheReadTokens += Number(current.cacheRead ?? 0);
    total.cacheWriteTokens += Number(current.cacheWrite ?? 0);
    total.costUsd += Number(current.cost?.total ?? 0);
    return total;
  },
  {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  },
);

const gatewayLog = await readFile(gatewayPath, "utf8");
const normalizedGatewayLog = gatewayLog.replaceAll('\\"', '"');
const hookAudit = normalizedGatewayLog
  .split("\n")
  .map((line) => {
    const start = line.indexOf(
      '{"schemaVersion":1,"component":"dataops-guardian"',
    );
    if (start < 0) {
      return undefined;
    }
    try {
      return JSON.parse(line.slice(start));
    } catch {
      return undefined;
    }
  })
  .filter(Boolean)
  .filter((event) => event.runId === rpc.runId);
const gateReviseDecisionCount = hookAudit.filter(
  (event) =>
    event.hook === "before_agent_finalize" && event.decision === "revise",
).length;
const honoredRevisionCount = normalizedGatewayLog
  .split("\n")
  .filter(
    (line) =>
      line.includes("before_agent_finalize requested one more pass") &&
      line.includes(rpc.runId),
  ).length;

await writeFile(
  auditPath,
  hookAudit.length > 0
    ? `${hookAudit.map((event) => JSON.stringify(event)).join("\n")}\n`
    : "",
  "utf8",
);

const summary = {
  schemaVersion: 1,
  trialId: rpc.trialId,
  arm,
  scenario: rpc.scenario,
  replicate: rpc.replicate,
  model: finalAssistant
    ? `${finalAssistant.provider}/${finalAssistant.model}`
    : null,
  responseModel: finalAssistant?.responseModel ?? null,
  runId: rpc.runId,
  sessionKey: rpc.sessionKey,
  promptSha256: createHash("sha256").update(rpc.prompt).digest("hex"),
  promptChars: rpc.prompt.length,
  modelCalls: assistants.length,
  toolCalls: toolCalls.map((call) => call.name),
  successfulTools: [...successfulTools],
  requiredTools: rpc.requiredTools,
  requiredToolsSucceeded,
  gateReviseDecisionCount,
  honoredRevisionCount,
  finalAnswerReleased: finalText.length > 0,
  reportsBlocked,
  unsupportedConclusionReleased,
  failOpenObserved:
    arm === "gated" &&
    honoredRevisionCount > 0 &&
    unsupportedConclusionReleased,
  finalText,
  usage,
  startedAt: rpc.startedAt,
  completedAt: rpc.completedAt,
};

const raw = {
  schemaVersion: 1,
  trial: summary,
  prompt: rpc.prompt,
  transcript: messages,
  toolCalls,
  toolResults,
  hookAudit,
  sourceFiles: {
    transcript: transcriptPath,
    gatewayLog: gatewayPath,
    rpc: rpcPath,
  },
};

await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
await writeFile(rawPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(summary)}\n`);
