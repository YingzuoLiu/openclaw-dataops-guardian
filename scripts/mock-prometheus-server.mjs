import http from "node:http";
import { appendFile } from "node:fs/promises";

const port = Number(process.argv[2] ?? "19090");
const requestLog = process.argv[3];
const delayMs = Number(process.env.GUARDIAN_MOCK_PROMETHEUS_DELAY_MS ?? "0");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("mock Prometheus port must be a valid integer");
}
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30_000) {
  throw new Error("GUARDIAN_MOCK_PROMETHEUS_DELAY_MS must be 0..30000");
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host}`);

  if (url.pathname === "/-/ready") {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end("ready\n");
    return;
  }

  if (url.pathname !== "/api/v1/query" || !url.searchParams.get("query")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "error", error: "not found" }));
    return;
  }

  if (requestLog) {
    await appendFile(
      requestLog,
      `${JSON.stringify({
        schemaVersion: 1,
        query: url.searchParams.get("query"),
        delayMs,
        recordedAt: new Date().toISOString(),
      })}\n`,
      "utf8",
    );
  }
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      status: "success",
      data: {
        resultType: "vector",
        result: [
          {
            metric: {
              __name__: "payment_success_rate",
              service: "payments",
              environment: "proof",
            },
            value: [Date.now() / 1_000, "0.7"],
          },
        ],
      },
    }),
  );
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock Prometheus listening on 127.0.0.1:${port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
