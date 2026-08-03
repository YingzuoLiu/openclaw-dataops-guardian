import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { canonicalizeAlertmanagerWebhook } from "../ingestion.js";
import { extractBearerToken, isValidBearerToken } from "./auth.js";
import { ALERTMANAGER_WEBHOOK_PATH, MAX_REQUEST_BODY_BYTES } from "./config.js";
import {
  BridgeConsistencyError,
  CheckpointConflictError,
  DeliveryOrderingError,
  isFailClosedError,
} from "./errors.js";
import { FingerprintLock } from "./fingerprint-lock.js";
import { GatewayPersistenceError } from "./gateway-incident-client.js";
import {
  processCanonicalAlertDelivery,
  type AlertDispositionResult,
  type ProcessorDeps,
} from "./processor.js";

export type HttpBridgeServerDeps = ProcessorDeps & {
  bearerToken: string;
  fingerprintLock: FingerprintLock;
};

/**
 * `req` and `res` share one TCP connection in HTTP/1.1, so a rejection path
 * must never destroy `req` before the response is flushed — that would tear
 * down the socket out from under our own `res.end()`. To still avoid
 * serving further requests on a connection we want to shed (auth/size/type
 * rejections), pass `closeConnection` to set `Connection: close`, which
 * closes the socket only *after* the response is fully written.
 */
function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  options: { closeConnection?: boolean; headers?: Record<string, string> } = {},
): void {
  const payload = JSON.stringify(body);
  if (!res.headersSent) {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
      ...(options.closeConnection ? { connection: "close" } : {}),
      ...options.headers,
    });
  }
  res.end(payload);
}

function isJsonContentType(value: string | string[] | undefined): boolean {
  const header = Array.isArray(value) ? value[0] : value;
  if (typeof header !== "string") {
    return false;
  }
  const [type] = header.split(";");
  return type?.trim().toLowerCase() === "application/json";
}

type BodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; reason: "body_too_large" };

/**
 * Reads the request body while enforcing `MAX_REQUEST_BODY_BYTES` as the
 * data streams in, so an oversized body is rejected — and the connection
 * dropped — before it is ever fully buffered in memory.
 */
function readBodyWithLimit(
  req: IncomingMessage,
  maxBytes: number,
): Promise<BodyReadResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    req.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        // Stop buffering further chunks; the connection is closed once the
        // 413 response is flushed (see the `closeConnection` call site).
        req.pause();
        resolve({ ok: false, reason: "body_too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ ok: true, body: Buffer.concat(chunks) });
    });
    req.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

async function handleRequest(
  deps: HttpBridgeServerDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const requestAt = deps.now();

  if (req.url !== ALERTMANAGER_WEBHOOK_PATH) {
    sendJson(res, 404, { ok: false, error: "not_found" }, { closeConnection: true });
    return;
  }
  if (req.method !== "POST") {
    sendJson(
      res,
      405,
      { ok: false, error: "method_not_allowed" },
      { closeConnection: true, headers: { allow: "POST" } },
    );
    return;
  }

  const providedToken = extractBearerToken(req.headers.authorization);
  if (!isValidBearerToken(providedToken, deps.bearerToken)) {
    deps.audit.record({
      kind: "request_rejected",
      at: requestAt,
      httpStatus: 401,
      reason:
        providedToken === undefined
          ? "missing_bearer_token"
          : "invalid_bearer_token",
    });
    sendJson(res, 401, { ok: false, error: "unauthorized" }, { closeConnection: true });
    return;
  }

  if (!isJsonContentType(req.headers["content-type"])) {
    deps.audit.record({
      kind: "request_rejected",
      at: requestAt,
      httpStatus: 415,
      reason: "unsupported_content_type",
    });
    sendJson(res, 415, { ok: false, error: "unsupported_media_type" }, { closeConnection: true });
    return;
  }

  const bodyResult = await readBodyWithLimit(req, MAX_REQUEST_BODY_BYTES);
  if (!bodyResult.ok) {
    deps.audit.record({
      kind: "request_rejected",
      at: requestAt,
      httpStatus: 413,
      reason: "body_too_large",
    });
    sendJson(res, 413, { ok: false, error: "payload_too_large" }, { closeConnection: true });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bodyResult.body.toString("utf8"));
  } catch {
    deps.audit.record({
      kind: "request_rejected",
      at: requestAt,
      httpStatus: 400,
      reason: "invalid_json",
    });
    sendJson(res, 400, { ok: false, error: "invalid_json" });
    return;
  }

  // The receiver stamps its own ingress time; nothing from the untrusted
  // payload is ever trusted as `receivedAt`.
  const receivedAt = deps.now();
  const canonical = canonicalizeAlertmanagerWebhook(payload, receivedAt);
  if (!canonical.ok) {
    deps.audit.record({
      kind: "request_rejected",
      at: requestAt,
      httpStatus: 400,
      reason: "invalid_envelope",
      envelopeReason: canonical.reason,
    });
    sendJson(res, 400, { ok: false, error: "invalid_envelope", reason: canonical.reason });
    return;
  }

  // Durable metadata-only record that this webhook was accepted at the
  // envelope level, independent of how each individual alert is later
  // routed. Deliberately excludes `groupKey` (it embeds label values, e.g.
  // `{}:{alertname="X"}`), `labels`, `annotations`, and the raw payload.
  deps.audit.record({
    kind: "webhook_received",
    at: receivedAt,
    receiver: canonical.metadata.receiver,
    groupStatus: canonical.metadata.groupStatus,
    truncatedAlerts: canonical.metadata.truncatedAlerts,
    acceptedCount: canonical.acceptedAlerts.length,
    rejectedCount: canonical.rejectedAlerts.length,
  });

  for (const rejected of canonical.rejectedAlerts) {
    deps.audit.record({
      kind: "alert_canonicalization_rejected",
      at: receivedAt,
      index: rejected.index,
      reason: rejected.reason,
    });
  }

  const results: AlertDispositionResult[] = [];
  let currentAccepted: (typeof canonical.acceptedAlerts)[number] | undefined;
  try {
    for (const accepted of canonical.acceptedAlerts) {
      currentAccepted = accepted;
      const result = await deps.fingerprintLock.run(
        accepted.delivery.fingerprint,
        () => processCanonicalAlertDelivery(deps, accepted.delivery),
      );
      results.push(result);
    }
  } catch (error) {
    if (error instanceof GatewayPersistenceError && currentAccepted) {
      deps.audit.record({
        kind: "persistence_failure",
        at: deps.now(),
        fingerprint: currentAccepted.delivery.fingerprint,
        deliveryId: currentAccepted.delivery.deliveryId,
        message: error.message,
      });
      sendJson(res, 503, {
        ok: false,
        error: "persistence_unavailable",
        processedCount: results.length,
        totalAcceptedCount: canonical.acceptedAlerts.length,
      });
      return;
    }
    if (isFailClosedError(error) && currentAccepted) {
      const errorType = error instanceof BridgeConsistencyError
        ? "consistency"
        : error instanceof CheckpointConflictError
          ? "checkpoint_conflict"
          : error instanceof DeliveryOrderingError
            ? "ordering"
            : "consistency";
      deps.audit.record({
        kind: "fail_closed",
        at: deps.now(),
        fingerprint: currentAccepted.delivery.fingerprint,
        deliveryId: currentAccepted.delivery.deliveryId,
        errorType,
        message: (error as Error).message,
      });
      sendJson(res, 503, {
        ok: false,
        error:
          errorType === "consistency"
            ? "consistency_check_failed"
            : errorType === "checkpoint_conflict"
              ? "checkpoint_conflict"
              : "delivery_ordering_conflict",
        processedCount: results.length,
        totalAcceptedCount: canonical.acceptedAlerts.length,
      });
      return;
    }
    throw error;
  }

  const hasRejection =
    canonical.rejectedAlerts.length > 0 ||
    results.some((result) => result.disposition === "rejected");

  sendJson(res, hasRejection ? 207 : 200, {
    ok: true,
    receivedAt,
    truncatedAlerts: canonical.metadata.truncatedAlerts,
    rejectedAtCanonicalization: canonical.rejectedAlerts,
    results,
  });
}

export function createHttpBridgeServer(deps: HttpBridgeServerDeps): Server {
  return createServer((req, res) => {
    handleRequest(deps, req, res).catch(() => {
      if (!res.headersSent) {
        sendJson(res, 500, { ok: false, error: "internal_error" });
      } else {
        res.destroy();
      }
    });
  });
}
