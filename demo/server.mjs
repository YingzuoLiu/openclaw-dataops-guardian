import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadDemoProjection } from "./projection.mjs";

const DEMO_ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = join(DEMO_ROOT, "public");
const DEFAULT_PORT = 4177;

const STATIC_FILES = new Map([
  ["/", { path: join(PUBLIC_ROOT, "index.html"), type: "text/html; charset=utf-8" }],
  ["/app.js", { path: join(PUBLIC_ROOT, "app.js"), type: "text/javascript; charset=utf-8" }],
  ["/styles.css", { path: join(PUBLIC_ROOT, "styles.css"), type: "text/css; charset=utf-8" }],
  [
    "/replay-state.mjs",
    { path: join(DEMO_ROOT, "replay-state.mjs"), type: "text/javascript; charset=utf-8" },
  ],
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'none'",
    "connect-src 'self'",
    "font-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

function responseHeaders(extra = {}) {
  return { ...SECURITY_HEADERS, ...extra };
}

function writeJson(response, status, value, headOnly = false) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(
    status,
    responseHeaders({
      "Content-Length": Buffer.byteLength(body),
      "Content-Type": "application/json; charset=utf-8",
    }),
  );
  response.end(headOnly ? undefined : body);
}

function writeText(response, status, value, headOnly = false) {
  response.writeHead(
    status,
    responseHeaders({
      "Content-Length": Buffer.byteLength(value),
      "Content-Type": "text/plain; charset=utf-8",
    }),
  );
  response.end(headOnly ? undefined : value);
}

export function createDemoRequestHandler(projection) {
  return async (request, response) => {
    const method = request.method ?? "GET";
    const headOnly = method === "HEAD";
    if (method !== "GET" && !headOnly) {
      writeText(response, 405, "Method not allowed\n");
      return;
    }

    const requestUrl = new URL(request.url ?? "/", "http://demo.local");
    if (requestUrl.pathname === "/healthz") {
      writeJson(response, 200, { ok: true, mode: projection.mode }, headOnly);
      return;
    }
    if (requestUrl.pathname === "/api/demo") {
      writeJson(response, 200, projection, headOnly);
      return;
    }

    const file = STATIC_FILES.get(requestUrl.pathname);
    if (!file) {
      writeText(response, 404, "Not found\n", headOnly);
      return;
    }

    try {
      const body = await readFile(file.path);
      response.writeHead(
        200,
        responseHeaders({
          "Content-Length": body.length,
          "Content-Type": file.type,
        }),
      );
      response.end(headOnly ? undefined : body);
    } catch (error) {
      process.stderr.write(`demo static read failed: ${error.message}\n`);
      writeText(response, 500, "Demo asset unavailable\n", headOnly);
    }
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

export async function startDemoServer({
  host = "127.0.0.1",
  port = DEFAULT_PORT,
} = {}) {
  const projection = await loadDemoProjection();
  let server = createServer(createDemoRequestHandler(projection));

  try {
    await listen(server, port, host);
  } catch (error) {
    if (error.code !== "EADDRINUSE" || port === 0) {
      throw error;
    }
    server = createServer(createDemoRequestHandler(projection));
    await listen(server, 0, host);
  }

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("demo server did not expose a TCP address");
  }

  return {
    server,
    projection,
    url: `http://${host}:${address.port}`,
  };
}

function launchBrowser(url) {
  if (process.env.CI || process.env.DEMO_NO_OPEN === "1") {
    return;
  }

  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else if (process.env.WSL_DISTRO_NAME) {
    command = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The printed loopback URL remains the stable fallback.
  }
}

async function main() {
  const configuredPort = Number(process.env.DEMO_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65535) {
    throw new Error("DEMO_PORT must be an integer between 0 and 65535");
  }

  const { server, projection, url } = await startDemoServer({
    host: process.env.DEMO_HOST ?? "127.0.0.1",
    port: configuredPort,
  });

  process.stdout.write(
    [
      "",
      `  ${projection.banner}`,
      `  Open: ${url}`,
      "  Offline replay only; no cluster, credentials, API keys, or external services.",
      "  Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );

  launchBrowser(url);

  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const invokedPath = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`demo failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

