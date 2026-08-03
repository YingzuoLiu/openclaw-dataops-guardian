import { readFileSync, writeFileSync } from "node:fs";

import {
  createIncidentOccurrenceId,
  readIncidentStateV3,
} from "../dist/state/incident-state.js";
import { beginRemediationAttempt } from "../dist/state/incident-workflow.js";
import {
  GatewayIncidentClient,
  incidentSessionKey,
} from "../dist/alertmanager/http-bridge/gateway-incident-client.js";
import { MAX_REQUEST_BODY_BYTES } from "../dist/alertmanager/http-bridge/config.js";

const phase = process.argv[2];
const fixturePath = process.argv[3];

const bridgeUrl = requireEnv("ALERTMANAGER_BRIDGE_URL");
const bridgeToken = requireEnv("ALERTMANAGER_BRIDGE_TOKEN");
const gatewayUrl = requireEnv("OPENCLAW_GATEWAY_URL");
const gatewayToken = requireEnv("OPENCLAW_GATEWAY_TOKEN");
const webhookUrl = `${bridgeUrl}/v1/alertmanager/webhook`;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}

function loadFixture() {
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function saveFixture(value) {
  writeFileSync(fixturePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * The bridge always stamps `receivedAt` from the real wall clock (never
 * trusting the payload), and rejects an alert whose `startsAt` is after
 * `receivedAt`. Every timestamp this proof sends must therefore stay safely
 * in the past no matter when the proof actually runs. `freshAnchorMs()`
 * picks a point three hours before "now" at the calling phase's own start;
 * offsets built from it with `anchorTimestamp` stay minutes apart from each
 * other while remaining hours in the past relative to real time throughout
 * the whole (much shorter) proof run.
 */
function freshAnchorMs() {
  return Date.now() - 3 * 60 * 60 * 1000;
}

function anchorTimestamp(anchorMs, offsetMinutes) {
  return new Date(anchorMs + offsetMinutes * 60_000).toISOString();
}

function plusMinutes(isoTimestamp, minutes) {
  return new Date(Date.parse(isoTimestamp) + minutes * 60_000).toISOString();
}

/**
 * Any delivery sent through the real bridge gets `receivedAt` stamped from
 * the *real* wall clock (never from the payload), which becomes the
 * occurrence's `lastReceivedAt`/`updatedAt`. Fabricated state built directly
 * against the Gateway (bypassing the bridge, e.g. to simulate an
 * operator/Lobster mutation) must therefore anchor its own timestamps to
 * real "now" too — an anchor-relative timestamp from hours in the past would
 * violate `updatedAt must not precede lastReceivedAt` once a real delivery
 * has already touched the occurrence.
 */
function realNowPlusSeconds(seconds) {
  return new Date(Date.now() + seconds * 1_000).toISOString();
}

const DEFAULT_ANCHOR_MS = freshAnchorMs();

function webhookAlert(overrides = {}) {
  return {
    status: "firing",
    labels: {
      alertname: "PaymentSuccessRateLow",
      namespace: "guardian-demo",
      deployment: "payments",
    },
    annotations: { summary: "Payments are unhealthy." },
    startsAt: anchorTimestamp(DEFAULT_ANCHOR_MS, 0),
    endsAt: anchorTimestamp(DEFAULT_ANCHOR_MS, 5),
    generatorURL: "http://prometheus.invalid/graph",
    fingerprint: "fingerprint-http-bridge-proof",
    ...overrides,
  };
}

function envelope(alerts, overrides = {}) {
  return {
    version: "4",
    groupKey: '{}:{alertname="PaymentSuccessRateLow"}',
    truncatedAlerts: 0,
    status: "firing",
    receiver: "guardian",
    groupLabels: { alertname: "PaymentSuccessRateLow" },
    commonLabels: {},
    commonAnnotations: {},
    externalURL: "http://alertmanager.invalid",
    alerts,
    ...overrides,
  };
}

async function postWebhook({ body, headers = {}, retries = 0, method = "POST" } = {}) {
  const requestInit = {
    method,
    headers: {
      authorization: `Bearer ${bridgeToken}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  };
  let lastResponse;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(webhookUrl, requestInit);
    const text = await response.text();
    lastResponse = {
      status: response.status,
      json: text.length > 0 ? JSON.parse(text) : undefined,
    };
    if (response.status !== 503 || attempt === retries) {
      return lastResponse;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return lastResponse;
}

async function connectGatewayClient() {
  const client = new GatewayIncidentClient({
    url: gatewayUrl,
    token: gatewayToken,
    clientDisplayName: "dataops-guardian-http-bridge-proof",
    requestTimeoutMs: 10_000,
    connectTimeoutMs: 15_000,
  });
  await client.connect();
  return client;
}

async function preflight() {
  // 1. Missing bearer token.
  const missingAuth = await postWebhook({
    headers: { authorization: "" },
    body: JSON.stringify(envelope([webhookAlert()])),
  });
  assert(missingAuth.status === 401, `missing auth expected 401, got ${missingAuth.status}`);

  // 2. Wrong bearer token.
  const wrongAuth = await postWebhook({
    headers: { authorization: "Bearer not-the-real-token" },
    body: JSON.stringify(envelope([webhookAlert()])),
  });
  assert(wrongAuth.status === 401, `wrong auth expected 401, got ${wrongAuth.status}`);

  // 3. Wrong content type.
  const wrongContentType = await postWebhook({
    headers: { "content-type": "text/plain" },
    body: JSON.stringify(envelope([webhookAlert()])),
  });
  assert(
    wrongContentType.status === 415,
    `wrong content-type expected 415, got ${wrongContentType.status}`,
  );

  // 4. Malformed JSON body.
  const malformedJson = await postWebhook({ body: "{not json" });
  assert(malformedJson.status === 400, `malformed json expected 400, got ${malformedJson.status}`);
  assert(malformedJson.json.error === "invalid_json", "expected invalid_json error code");

  // 5. Body exceeds the fixed size limit.
  const oversizedBody = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
  const tooLarge = await postWebhook({ body: oversizedBody });
  assert(tooLarge.status === 413, `oversized body expected 413, got ${tooLarge.status}`);

  // 6. Well-formed JSON, valid auth/content-type, but an invalid envelope.
  const invalidEnvelope = await postWebhook({
    body: JSON.stringify({ ...envelope([webhookAlert()]), version: "3" }),
  });
  assert(
    invalidEnvelope.status === 400 && invalidEnvelope.json.reason === "unsupported_version",
    `invalid envelope expected 400/unsupported_version, got ${JSON.stringify(invalidEnvelope)}`,
  );

  // 7. Correct path, wrong method: 405, not 404.
  const wrongMethod = await postWebhook({ method: "GET" });
  assert(
    wrongMethod.status === 405,
    `wrong method on the correct path expected 405, got ${wrongMethod.status}`,
  );

  console.log(JSON.stringify({ ok: true, phase, checks: 7 }));
}

async function coreAndDefer() {
  const fingerprint = "fingerprint-http-bridge-proof";
  const anchorMs = freshAnchorMs();
  const t = (offsetMinutes) => anchorTimestamp(anchorMs, offsetMinutes);

  const originalStartsAt = t(0);
  const originalReceivedAt = t(1);

  // Partial alert rejection: one valid alert alongside one missing alertname.
  const partial = await postWebhook({
    body: JSON.stringify(
      envelope([
        webhookAlert({ startsAt: originalStartsAt }),
        {
          status: "firing",
          labels: { namespace: "guardian-demo" },
          annotations: {},
          startsAt: originalStartsAt,
          endsAt: null,
          generatorURL: "http://prometheus.invalid/graph",
          fingerprint: "fingerprint-missing-alertname",
        },
      ]),
    ),
  });
  assert(partial.status === 207, `partial rejection expected 207, got ${partial.status}`);
  assert(partial.json.rejectedAtCanonicalization.length === 1, "expected one canonicalization rejection");
  assert(
    partial.json.rejectedAtCanonicalization[0].reason === "missing_alertname",
    "expected missing_alertname rejection reason",
  );
  assert(partial.json.results.length === 1, "expected exactly one accepted alert result");
  assert(partial.json.results[0].disposition === "created", "expected the valid alert to be created");

  const originalOccurrenceId = createIncidentOccurrenceId(fingerprint, originalStartsAt);
  const originalSessionKey = incidentSessionKey(originalOccurrenceId);
  assert(
    partial.json.results[0].occurrenceId === originalOccurrenceId,
    "created occurrenceId did not match the deterministic id",
  );

  // Repeat delivery dedup.
  const duplicate = await postWebhook({
    body: JSON.stringify(envelope([webhookAlert({ startsAt: originalStartsAt })])),
  });
  assert(duplicate.status === 200, `duplicate expected 200, got ${duplicate.status}`);
  assert(duplicate.json.results[0].disposition === "duplicate", "expected a duplicate disposition");

  // A different fingerprint's new startsAt with nothing running routes straight
  // to a fresh occurrence (no deferral needed).
  const otherFingerprint = "fingerprint-http-bridge-proof-other";
  const otherFirst = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint: otherFingerprint, startsAt: t(2) })]),
    ),
  });
  assert(otherFirst.json.results[0].disposition === "created", "expected other-fingerprint created");
  const otherSecond = await postWebhook({
    body: JSON.stringify(
      envelope([
        webhookAlert({
          fingerprint: otherFingerprint,
          startsAt: t(3),
          endsAt: t(3.5),
        }),
      ]),
    ),
  });
  assert(
    otherSecond.json.results[0].disposition === "new_occurrence",
    `expected new_occurrence for a fresh startsAt with nothing running, got ${otherSecond.json.results[0].disposition}`,
  );

  // Fabricate a running remediation attempt directly against the Gateway
  // (bypassing the bridge, exactly as an operator/Lobster workflow would)
  // so the next delivery for a new startsAt must defer instead of routing.
  const gateway = await connectGatewayClient();
  try {
    const currentValue = await gateway.describeIncidentState(originalSessionKey);
    const decoded = readIncidentStateV3(currentValue);
    assert(decoded.ok, `original occurrence state failed to decode: ${JSON.stringify(decoded)}`);
    const approved = {
      ...decoded.state,
      stage: "remediation",
      approvalStatus: "approved",
      proposedAction: "synthetic_http_bridge_proof_mutation",
    };
    const started = beginRemediationAttempt(approved, {
      idempotencyKey: "http-bridge-proof-attempt-1",
      target: { kind: "synthetic_http_bridge_proof", resource: "payments" },
      startedAt: realNowPlusSeconds(1),
    });
    assert(started.decision === "started", `remediation attempt did not start: ${started.decision}`);
    await gateway.persistIncidentState(originalSessionKey, started.state);
  } finally {
    await gateway.close();
  }

  // A new startsAt for the same fingerprint must now be deferred.
  const heldStartsAt = t(5);
  const heldReceivedAt = t(6);
  const deferred = await postWebhook({
    body: JSON.stringify(
      envelope([
        webhookAlert({
          startsAt: heldStartsAt,
          endsAt: t(5.5),
        }),
      ]),
    ),
  });
  assert(deferred.status === 200, `deferred delivery expected 200, got ${deferred.status}`);
  assert(
    deferred.json.results[0].disposition === "deferred_new_occurrence",
    `expected deferred_new_occurrence, got ${deferred.json.results[0].disposition}`,
  );
  assert(
    deferred.json.results[0].occurrenceId === originalOccurrenceId,
    "deferred delivery should report the blocking (original) occurrenceId",
  );

  const heldOccurrenceId = createIncidentOccurrenceId(fingerprint, heldStartsAt);
  const heldSessionKey = incidentSessionKey(heldOccurrenceId);

  saveFixture({
    anchorMs,
    fingerprint,
    originalStartsAt,
    originalReceivedAt,
    originalOccurrenceId,
    originalSessionKey,
    heldStartsAt,
    heldReceivedAt,
    heldOccurrenceId,
    heldSessionKey,
  });

  console.log(JSON.stringify({ ok: true, phase, originalOccurrenceId, heldOccurrenceId }));
}

async function persistenceFailure() {
  const response = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint: "fingerprint-persistence-failure" })]),
    ),
  });
  assert(response.status === 503, `expected 503 while the gateway is down, got ${response.status}`);
  assert(response.json.error === "persistence_unavailable", "expected persistence_unavailable error code");
  console.log(JSON.stringify({ ok: true, phase }));
}

/**
 * Polls the bridge with an isolated, throwaway probe delivery until it can
 * reach the Gateway again, instead of assuming any fixed delay is enough.
 *
 * The bridge process here was never restarted across the `persistence-failure`
 * phase — only the Gateway process was stopped and now a fresh one has been
 * started — so recovery depends on the bridge's own long-lived
 * `GatewayClient` reconnecting on its own. That reconnect uses exponential
 * backoff (starting at 1s, doubling up to a 30s cap; see
 * `node_modules/openclaw/dist/client-*.js`), so how long it actually takes
 * to notice the Gateway is back depends on exactly where in that backoff
 * cycle the drop was detected — it is not bounded by anything this proof
 * controls, and a single-digit-second retry budget can legitimately not be
 * enough even with no bug involved. This is a real bounded wait (never an
 * unconditional `sleep`, and never an unbounded one either): it polls on a
 * short fixed interval up to `timeoutMs`, and only stops early on success.
 *
 * The probe fingerprint/occurrence is entirely disjoint from every other
 * phase's fixtures, so this can never interact with (or be confused for)
 * the checkpoint under test elsewhere in this proof. On every failed
 * attempt it reads the bridge's own durable `audit.jsonl` for the
 * corresponding `persistence_failure` record and prints its `message`
 * (the real underlying Gateway RPC failure reason — a connect timeout, a
 * dropped socket, ... — set in `GatewayIncidentClient`) to `stderr`. That
 * message is never sent back over HTTP (the response only ever carries the
 * sanitized `persistence_unavailable` code), so reading it back out of the
 * audit trail is the only way to see the real cause here. If the deadline
 * is reached, the last such reason is included in the thrown error so a
 * genuine stuck-reconnect bug fails loudly with an actual explanation
 * instead of a bare timeout.
 */
async function waitForGatewayReachable() {
  const timeoutMs = Number(
    process.env.ALERTMANAGER_BRIDGE_PROOF_READINESS_TIMEOUT_MS ?? 45_000,
  );
  const intervalMs = 1_000;
  const fingerprint = "fingerprint-http-bridge-proof-readiness-probe";
  const auditPath = `${requireEnv("ALERTMANAGER_BRIDGE_STATE_DIR")}/audit.jsonl`;
  const deadline = Date.now() + timeoutMs;

  let lastReason = "(no persistence_failure audit entry seen yet)";
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const anchorMs = freshAnchorMs() - attempt * 60_000;
    const response = await postWebhook({
      body: JSON.stringify(
        envelope([
          webhookAlert({
            fingerprint,
            startsAt: anchorTimestamp(anchorMs, 0),
            endsAt: anchorTimestamp(anchorMs, 5),
          }),
        ]),
      ),
    });

    if (response.status === 200) {
      console.log(JSON.stringify({ ok: true, phase, attempts: attempt }));
      return;
    }
    if (response.status !== 503 || response.json?.error !== "persistence_unavailable") {
      throw new Error(
        `wait-for-gateway-reachable: unexpected response on attempt ${attempt}: ` +
          `${response.status} ${JSON.stringify(response.json)}`,
      );
    }

    const reason = readLatestPersistenceFailureReason(auditPath, fingerprint);
    if (reason !== undefined) {
      lastReason = reason;
    }
    process.stderr.write(
      `wait-for-gateway-reachable: attempt ${attempt} still persistence_unavailable: ${lastReason}\n`,
    );

    if (Date.now() >= deadline) {
      throw new Error(
        `wait-for-gateway-reachable: gave up after ${timeoutMs}ms (${attempt} attempts); ` +
          `last underlying reason: ${lastReason}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readLatestPersistenceFailureReason(auditPath, fingerprint) {
  let entries;
  try {
    entries = readFileSync(auditPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return undefined;
  }
  const matching = entries.filter(
    (entry) => entry.kind === "persistence_failure" && entry.fingerprint === fingerprint,
  );
  return matching.length > 0 ? matching[matching.length - 1].message : undefined;
}

async function verifyCheckpointStillHeld() {
  const fixture = loadFixture();
  // Re-sending the held delivery must still report deferred_new_occurrence:
  // the blocking attempt has not been settled, so a bridge restart must not
  // have silently replayed or dropped it.
  const original = await postWebhook({
    retries: 5,
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint: fixture.fingerprint, startsAt: fixture.originalStartsAt })]),
    ),
  });
  assert(original.status === 200, `expected 200, got ${original.status}: ${JSON.stringify(original.json)}`);
  assert(
    original.json.results[0].disposition === "duplicate" &&
      original.json.results[0].occurrenceId === fixture.originalOccurrenceId,
    `expected the original occurrence to still dedup correctly, got ${JSON.stringify(original.json.results[0])}`,
  );

  const response = await postWebhook({
    retries: 5,
    body: JSON.stringify(
      envelope([
        webhookAlert({
          fingerprint: fixture.fingerprint,
          startsAt: fixture.heldStartsAt,
          endsAt: plusMinutes(fixture.heldStartsAt, 5),
        }),
      ]),
    ),
  });
  assert(response.status === 200, `expected 200 after restart, got ${response.status}: ${JSON.stringify(response.json)}`);
  assert(
    response.json.results[0].disposition === "deferred_new_occurrence",
    `expected the delivery to remain held after restart, got ${response.json.results[0].disposition}`,
  );
  assert(
    response.json.results[0].occurrenceId === fixture.originalOccurrenceId,
    "held delivery should still report the original blocking occurrence",
  );
  console.log(JSON.stringify({ ok: true, phase }));
}

async function settleAndDrain() {
  const fixture = loadFixture();
  const gateway = await connectGatewayClient();
  try {
    const currentValue = await gateway.describeIncidentState(fixture.originalSessionKey);
    const decoded = readIncidentStateV3(currentValue);
    assert(decoded.ok, `original occurrence state failed to decode: ${JSON.stringify(decoded)}`);
    const running = decoded.state.remediationAttempts[0];
    assert(running?.status === "running", "expected a running remediation attempt to settle");
    const settledAt = realNowPlusSeconds(1);
    const settled = {
      ...decoded.state,
      stage: "recovery_check",
      remediationAttempts: [
        { ...running, status: "succeeded", finishedAt: settledAt, error: null },
      ],
      updatedAt: settledAt,
    };
    await gateway.persistIncidentState(fixture.originalSessionKey, settled);
  } finally {
    await gateway.close();
  }

  // Resend the held delivery itself. The bridge drains the pending
  // checkpoint for this fingerprint before handling any new delivery for it,
  // so this single request both replays the checkpoint into its new
  // occurrence and then dedups against the delivery the drain just applied.
  //
  // (Deliberately not resending the *original* delivery here: the fingerprint
  // route now points at the replayed occurrence, so an older startsAt would
  // itself be routed as a fresh `new_occurrence` rather than a duplicate —
  // correct reducer behavior, since a fingerprint has exactly one current
  // occurrence, but not what this phase is trying to verify.)
  const response = await postWebhook({
    retries: 5,
    body: JSON.stringify(
      envelope([
        webhookAlert({
          fingerprint: fixture.fingerprint,
          startsAt: fixture.heldStartsAt,
          endsAt: plusMinutes(fixture.heldStartsAt, 5),
        }),
      ]),
    ),
  });
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(response.json)}`);
  assert(
    response.json.results[0].disposition === "duplicate" &&
      response.json.results[0].occurrenceId === fixture.heldOccurrenceId,
    `expected the resend to dedup against the replayed occurrence, got ${JSON.stringify(response.json.results[0])}`,
  );

  const gateway2 = await connectGatewayClient();
  try {
    const heldValue = await gateway2.describeIncidentState(fixture.heldSessionKey);
    const heldDecoded = readIncidentStateV3(heldValue);
    assert(heldDecoded.ok, "replayed occurrence did not durably land in the gateway");
    assert(
      heldDecoded.state.recentDeliveryIds.length === 1,
      "replayed occurrence should record exactly one delivery",
    );
  } finally {
    await gateway2.close();
  }

  console.log(JSON.stringify({ ok: true, phase }));
}

/**
 * Used only after the checkpoint has been replayed (`settle-and-drain` has
 * run): confirms the fingerprint's route and the replayed occurrence's
 * state both survived a restart, by dedup-checking the held delivery
 * against its now-current occurrence. Never touches the original delivery
 * (see the comment in `settleAndDrain`).
 */
async function verifyReplayedOccurrence() {
  const fixture = loadFixture();
  const held = await postWebhook({
    retries: 5,
    body: JSON.stringify(
      envelope([
        webhookAlert({
          fingerprint: fixture.fingerprint,
          startsAt: fixture.heldStartsAt,
          endsAt: plusMinutes(fixture.heldStartsAt, 5),
        }),
      ]),
    ),
  });
  assert(held.status === 200, `expected 200, got ${held.status}: ${JSON.stringify(held.json)}`);
  assert(
    held.json.results[0].disposition === "duplicate" &&
      held.json.results[0].occurrenceId === fixture.heldOccurrenceId,
    `expected the replayed occurrence to dedup correctly, got ${JSON.stringify(held.json.results[0])}`,
  );
  console.log(JSON.stringify({ ok: true, phase }));
}

/**
 * Two different deferred deliveries for the same fingerprint: the first
 * must be held durably (2xx) and never overwritten; the second, conflicting
 * one must be rejected (non-2xx) rather than silently discarding the first.
 * Uses its own fingerprint/timeline, independent of the other phases.
 */
async function checkpointConflict() {
  const fingerprint = "fingerprint-http-bridge-proof-checkpoint-conflict";
  const anchorMs = freshAnchorMs();
  const t = (offsetMinutes) => anchorTimestamp(anchorMs, offsetMinutes);

  const originalStartsAt = t(0);
  const created = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint, startsAt: originalStartsAt, endsAt: t(5) })]),
    ),
  });
  assert(
    created.status === 200 && created.json.results[0].disposition === "created",
    `expected created, got ${JSON.stringify(created.json)}`,
  );
  const occurrenceId = createIncidentOccurrenceId(fingerprint, originalStartsAt);
  const sessionKey = incidentSessionKey(occurrenceId);

  const gateway = await connectGatewayClient();
  try {
    const currentValue = await gateway.describeIncidentState(sessionKey);
    const decoded = readIncidentStateV3(currentValue);
    assert(decoded.ok, `occurrence state failed to decode: ${JSON.stringify(decoded)}`);
    const approved = {
      ...decoded.state,
      stage: "remediation",
      approvalStatus: "approved",
      proposedAction: "synthetic_checkpoint_conflict_mutation",
    };
    const started = beginRemediationAttempt(approved, {
      idempotencyKey: "checkpoint-conflict-attempt-1",
      target: { kind: "synthetic_checkpoint_conflict" },
      startedAt: realNowPlusSeconds(1),
    });
    assert(started.decision === "started", `remediation attempt did not start: ${started.decision}`);
    await gateway.persistIncidentState(sessionKey, started.state);
  } finally {
    await gateway.close();
  }

  const firstHeldStartsAt = t(10);
  const first = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint, startsAt: firstHeldStartsAt, endsAt: t(10.5) })]),
    ),
  });
  assert(
    first.status === 200,
    `expected 200 for the first deferred delivery, got ${first.status}: ${JSON.stringify(first.json)}`,
  );
  assert(
    first.json.results[0].disposition === "deferred_new_occurrence",
    `expected the first delivery to be deferred, got ${JSON.stringify(first.json.results[0])}`,
  );

  const secondHeldStartsAt = t(20);
  const second = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint, startsAt: secondHeldStartsAt, endsAt: t(20.5) })]),
    ),
  });
  assert(
    second.status === 503,
    `expected 503 for the conflicting deferred delivery, got ${second.status}: ${JSON.stringify(second.json)}`,
  );
  assert(
    second.json.error === "checkpoint_conflict",
    `expected checkpoint_conflict error code, got ${JSON.stringify(second.json)}`,
  );

  const secondOccurrenceId = createIncidentOccurrenceId(fingerprint, secondHeldStartsAt);
  const gateway2 = await connectGatewayClient();
  try {
    const secondState = await gateway2.describeIncidentState(incidentSessionKey(secondOccurrenceId));
    assert(secondState === undefined, "the conflicting delivery's occurrence must not have been created");
  } finally {
    await gateway2.close();
  }

  // The first held delivery must still be intact: resending it must still
  // report deferred_new_occurrence against the same blocking occurrence.
  const resendFirst = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint, startsAt: firstHeldStartsAt, endsAt: t(10.5) })]),
    ),
  });
  assert(
    resendFirst.status === 200,
    `expected 200 resending the first held delivery, got ${resendFirst.status}`,
  );
  assert(
    resendFirst.json.results[0].disposition === "deferred_new_occurrence" &&
      resendFirst.json.results[0].occurrenceId === occurrenceId,
    `expected the first held delivery to still be intact, got ${JSON.stringify(resendFirst.json.results[0])}`,
  );

  console.log(JSON.stringify({ ok: true, phase }));
}

/**
 * A firing -> B firing -> delayed A firing -> delayed A resolved. The
 * active route must stay at B throughout; the delayed deliveries for A must
 * land on A's own occurrence (dedup, then resolve) without moving the route
 * or being treated as orphaned. Uses its own fingerprint/timeline.
 */
async function routeRegression() {
  const fingerprint = "fingerprint-http-bridge-proof-route-regression";
  const anchorMs = freshAnchorMs();
  const t = (offsetMinutes) => anchorTimestamp(anchorMs, offsetMinutes);

  const startsAtA = t(0);
  const a = await postWebhook({
    body: JSON.stringify(envelope([webhookAlert({ fingerprint, startsAt: startsAtA, endsAt: t(5) })])),
  });
  assert(
    a.status === 200 && a.json.results[0].disposition === "created",
    `expected A created, got ${JSON.stringify(a.json)}`,
  );
  const occurrenceIdA = createIncidentOccurrenceId(fingerprint, startsAtA);

  const startsAtB = t(10);
  const b = await postWebhook({
    body: JSON.stringify(envelope([webhookAlert({ fingerprint, startsAt: startsAtB, endsAt: t(15) })])),
  });
  assert(
    b.status === 200 && b.json.results[0].disposition === "new_occurrence",
    `expected B new_occurrence, got ${JSON.stringify(b.json)}`,
  );
  const occurrenceIdB = createIncidentOccurrenceId(fingerprint, startsAtB);
  assert(occurrenceIdA !== occurrenceIdB, "A and B must be independent occurrences");

  // A delayed resend of A's original firing delivery must dedup against A
  // and must not move the route.
  const delayedA = await postWebhook({
    body: JSON.stringify(envelope([webhookAlert({ fingerprint, startsAt: startsAtA, endsAt: t(5) })])),
  });
  assert(delayedA.status === 200, `expected 200, got ${delayedA.status}: ${JSON.stringify(delayedA.json)}`);
  assert(
    delayedA.json.results[0].disposition === "duplicate" &&
      delayedA.json.results[0].occurrenceId === occurrenceIdA,
    `expected delayed A to dedup against A, got ${JSON.stringify(delayedA.json.results[0])}`,
  );

  // A delayed resolution for A must update A's own occurrence — not be
  // treated as orphaned — and must still not move the route.
  const delayedAResolved = await postWebhook({
    body: JSON.stringify(
      envelope(
        [
          webhookAlert({
            fingerprint,
            status: "resolved",
            startsAt: startsAtA,
            endsAt: t(6),
          }),
        ],
        { status: "resolved" },
      ),
    ),
  });
  assert(
    delayedAResolved.status === 200,
    `expected 200, got ${delayedAResolved.status}: ${JSON.stringify(delayedAResolved.json)}`,
  );
  assert(
    delayedAResolved.json.results[0].disposition === "updated" &&
      delayedAResolved.json.results[0].occurrenceId === occurrenceIdA,
    `expected delayed A resolved to update A, got ${JSON.stringify(delayedAResolved.json.results[0])}`,
  );

  // The route must still be at B: resending B's delivery must dedup
  // against B, not treat it as stale.
  const resendB = await postWebhook({
    body: JSON.stringify(envelope([webhookAlert({ fingerprint, startsAt: startsAtB, endsAt: t(15) })])),
  });
  assert(resendB.status === 200, `expected 200, got ${resendB.status}: ${JSON.stringify(resendB.json)}`);
  assert(
    resendB.json.results[0].disposition === "duplicate" &&
      resendB.json.results[0].occurrenceId === occurrenceIdB,
    `expected B to still be the active occurrence, got ${JSON.stringify(resendB.json.results[0])}`,
  );

  console.log(JSON.stringify({ ok: true, phase }));
}

/**
 * `receivedAt` is stamped once per HTTP attempt, before the fingerprint's
 * serialization lock is acquired, so two concurrent requests for the same
 * fingerprint can reach the reducer out of receivedAt order. This proof
 * cannot reliably force a real network race deterministically, so it
 * reproduces the exact same observable condition the reducer itself
 * detects (`received_at_regression`) by directly advancing the occurrence's
 * `lastReceivedAt` past what a real "losing" request would stamp — from the
 * bridge's point of view this is indistinguishable from having actually
 * lost the race. Asserts the "losing" delivery gets `503`, is never
 * recorded, and that a retry after the transient condition clears succeeds.
 */
async function deliveryOrderingConflict() {
  const fingerprint = "fingerprint-http-bridge-proof-ordering";
  const anchorMs = freshAnchorMs();
  const startsAt = anchorTimestamp(anchorMs, 0);

  const created = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint, startsAt, endsAt: anchorTimestamp(anchorMs, 5) })]),
    ),
  });
  assert(
    created.status === 200 && created.json.results[0].disposition === "created",
    `expected created, got ${JSON.stringify(created.json)}`,
  );
  const occurrenceId = createIncidentOccurrenceId(fingerprint, startsAt);
  const sessionKey = incidentSessionKey(occurrenceId);

  const advancedLastReceivedAt = realNowPlusSeconds(120);
  const gateway = await connectGatewayClient();
  try {
    const currentValue = await gateway.describeIncidentState(sessionKey);
    const decoded = readIncidentStateV3(currentValue);
    assert(decoded.ok, `occurrence state failed to decode: ${JSON.stringify(decoded)}`);
    // Simulates a concurrent request for this fingerprint having already
    // advanced the clock further than this next delivery's own receivedAt
    // will land — exactly the condition a genuinely losing race produces.
    await gateway.persistIncidentState(sessionKey, {
      ...decoded.state,
      lastReceivedAt: advancedLastReceivedAt,
      updatedAt: advancedLastReceivedAt,
    });
  } finally {
    await gateway.close();
  }

  const losing = await postWebhook({
    body: JSON.stringify(
      envelope([
        webhookAlert({ fingerprint, startsAt, endsAt: anchorTimestamp(anchorMs, 5) }),
      ]),
    ),
  });
  assert(
    losing.status === 503,
    `expected 503 for a delivery that lost the receivedAt race, got ${losing.status}: ${JSON.stringify(losing.json)}`,
  );
  assert(
    losing.json.error === "delivery_ordering_conflict",
    `expected delivery_ordering_conflict error code, got ${JSON.stringify(losing.json)}`,
  );

  const gateway2 = await connectGatewayClient();
  let deliveryCountAfterLoss;
  try {
    const value = await gateway2.describeIncidentState(sessionKey);
    const decoded = readIncidentStateV3(value);
    assert(decoded.ok, "occurrence state failed to decode after the rejected delivery");
    // The losing delivery must never have been recorded — it was not
    // silently confirmed away inside a 2xx.
    deliveryCountAfterLoss = decoded.state.deliveryCount;
    assert(
      decoded.state.lastReceivedAt === advancedLastReceivedAt,
      "the rejected delivery must not have changed lastReceivedAt",
    );
  } finally {
    await gateway2.close();
  }

  // The transient condition clears (real time catching up, or — as
  // simulated here — the concurrent winner's effect settling), and a retry
  // of the exact same delivery must now succeed rather than being
  // permanently lost.
  const gateway3 = await connectGatewayClient();
  try {
    const value = await gateway3.describeIncidentState(sessionKey);
    const decoded = readIncidentStateV3(value);
    assert(decoded.ok, "occurrence state failed to decode before retry");
    await gateway3.persistIncidentState(sessionKey, {
      ...decoded.state,
      lastReceivedAt: anchorTimestamp(anchorMs, 1),
      updatedAt: anchorTimestamp(anchorMs, 1),
    });
  } finally {
    await gateway3.close();
  }

  const retried = await postWebhook({
    body: JSON.stringify(
      envelope([
        webhookAlert({ fingerprint, startsAt, endsAt: anchorTimestamp(anchorMs, 5) }),
      ]),
    ),
  });
  assert(
    retried.status === 200,
    `expected the retry to succeed once the transient condition cleared, got ${retried.status}: ${JSON.stringify(retried.json)}`,
  );
  // This retry resends the exact same canonical content as the original
  // `created` delivery (same fingerprint/status/startsAt/endsAt), so its
  // deliveryId is identical and the reducer's dedup check makes "duplicate"
  // the deterministic outcome here — the delivery was never actually lost
  // (the original `created` call already recorded it), so redelivering it
  // safely dedupes rather than double-applying. Either "duplicate" or
  // "updated" is an acceptable proof that the delivery is not permanently
  // stuck behind the 503: what must never happen is the retry itself being
  // rejected again.
  assert(
    ["duplicate", "updated"].includes(retried.json.results[0].disposition),
    `expected the retry to be recorded (duplicate or updated), got ${JSON.stringify(retried.json.results[0])}`,
  );

  const gateway4 = await connectGatewayClient();
  try {
    const value = await gateway4.describeIncidentState(sessionKey);
    const decoded = readIncidentStateV3(value);
    assert(decoded.ok, "occurrence state failed to decode after retry");
    assert(
      decoded.state.deliveryCount === deliveryCountAfterLoss + 1,
      "the retried delivery should be recorded exactly once, not lost and not double-counted",
    );
  } finally {
    await gateway4.close();
  }

  console.log(JSON.stringify({ ok: true, phase }));
}

/**
 * A successfully canonicalized webhook must produce a durable
 * `webhook_received` audit record carrying only metadata (receiver,
 * groupStatus, truncatedAlerts, accepted/rejected counts) — never the raw
 * payload, groupKey, labels, annotations, or the bearer token. Uses a
 * distinctive `truncatedAlerts` value so this phase's own record is
 * unambiguous among any earlier phases' entries in the same audit.jsonl.
 */
async function truncatedAlertsAudit() {
  const fingerprint = "fingerprint-http-bridge-proof-truncated";
  const anchorMs = freshAnchorMs();
  const t = (offsetMinutes) => anchorTimestamp(anchorMs, offsetMinutes);

  const response = await postWebhook({
    body: JSON.stringify(
      envelope([webhookAlert({ fingerprint, startsAt: t(0), endsAt: t(5) })], {
        truncatedAlerts: 3,
      }),
    ),
  });
  assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(response.json)}`);
  assert(response.json.truncatedAlerts === 3, "response did not echo truncatedAlerts=3");

  const auditPath = `${requireEnv("ALERTMANAGER_BRIDGE_STATE_DIR")}/audit.jsonl`;
  const entries = readFileSync(auditPath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const matching = entries.filter(
    (entry) => entry.kind === "webhook_received" && entry.truncatedAlerts === 3,
  );
  assert(matching.length > 0, "expected a webhook_received audit entry with truncatedAlerts=3");
  const entry = matching[matching.length - 1];
  assert(entry.receiver === "guardian", `expected receiver=guardian, got ${JSON.stringify(entry)}`);
  assert(entry.groupStatus === "firing", `expected groupStatus=firing, got ${JSON.stringify(entry)}`);
  assert(entry.acceptedCount === 1, `expected acceptedCount=1, got ${JSON.stringify(entry)}`);
  assert(entry.rejectedCount === 0, `expected rejectedCount=0, got ${JSON.stringify(entry)}`);
  const serialized = JSON.stringify(entry);
  assert(
    !("groupKey" in entry) &&
      !("labels" in entry) &&
      !("annotations" in entry) &&
      !serialized.includes("PaymentSuccessRateLow") &&
      !serialized.includes(bridgeToken),
    `audit entry must not contain raw payload/groupKey/labels/annotations/token, got ${serialized}`,
  );

  console.log(JSON.stringify({ ok: true, phase }));
}

const phases = {
  preflight,
  "core-and-defer": coreAndDefer,
  "persistence-failure": persistenceFailure,
  "verify-checkpoint-still-held": verifyCheckpointStillHeld,
  "settle-and-drain": settleAndDrain,
  "verify-replayed-occurrence": verifyReplayedOccurrence,
  "checkpoint-conflict": checkpointConflict,
  "route-regression": routeRegression,
  "truncated-alerts-audit": truncatedAlertsAudit,
  "delivery-ordering-conflict": deliveryOrderingConflict,
  "wait-for-gateway-reachable": waitForGatewayReachable,
};

const handler = phases[phase];
if (!handler) {
  throw new Error(
    `usage: node scripts/alertmanager-http-bridge-proof.mjs <${Object.keys(phases).join("|")}> [fixturePath]`,
  );
}
await handler();
