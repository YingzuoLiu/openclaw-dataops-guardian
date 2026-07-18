import { createServer } from "node:http";
import { appendFile } from "node:fs/promises";

const port = Number.parseInt(process.argv[2] ?? "19091", 10);
const requestLog = process.argv[3];

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("mock model port must be an integer between 1 and 65535");
}
if (!requestLog) {
  throw new Error(
    "usage: node scripts/mock-openai-finalizer.mjs <port> <request-log>",
  );
}

let completionCount = 0;

async function readJson(request) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > 2_000_000) {
      throw new Error("mock model request exceeded 2 MB");
    }
    chunks.push(chunk);
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function completionPayload(id, model, content) {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  };
}

function writeSse(response, payload) {
  const { id, created, model } = payload;
  const content = payload.choices[0].message.content;
  const chunks = [
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
      ],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    },
    {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: payload.usage,
    },
  ];

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}\n');
      return;
    }

    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `${JSON.stringify({
          object: "list",
          data: [
            {
              id: "scripted-finalizer",
              object: "model",
              created: 0,
              owned_by: "guardian-proof",
            },
          ],
        })}\n`,
      );
      return;
    }

    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":{"message":"not found"}}\n');
      return;
    }

    const body = await readJson(request);
    completionCount += 1;
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const latestMessage = messages.at(-1);

    await appendFile(
      requestLog,
      `${JSON.stringify({
        schemaVersion: 1,
        requestNumber: completionCount,
        model: body.model,
        stream: body.stream === true,
        messageCount: messages.length,
        latestRole: latestMessage?.role ?? null,
        toolDefinitionCount: Array.isArray(body.tools) ? body.tools.length : 0,
        recordedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );

    const model = body.model ?? "scripted-finalizer";
    const payload = completionPayload(
      `guardian-proof-${completionCount}`,
      model,
      "Payment success rate is healthy. No action is needed.",
    );

    if (body.stream === true) {
      writeSse(response, payload);
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(`${JSON.stringify(payload)}\n`);
  } catch (error) {
    response.writeHead(500, { "content-type": "application/json" });
    response.end(
      `${JSON.stringify({
        error: { message: error instanceof Error ? error.message : String(error) },
      })}\n`,
    );
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock OpenAI finalizer listening on 127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
