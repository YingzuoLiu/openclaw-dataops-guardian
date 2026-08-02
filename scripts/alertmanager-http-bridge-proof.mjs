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

async function postWebhook({ body, headers = {}, retries = 0 } = {}) {
  const requestInit = {
    method: "POST",
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

  console.log(JSON.stringify({ ok: true, phase, checks: 6 }));
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

const phases = {
  preflight,
  "core-and-defer": coreAndDefer,
  "persistence-failure": persistenceFailure,
  "verify-checkpoint-still-held": verifyCheckpointStillHeld,
  "settle-and-drain": settleAndDrain,
  "verify-replayed-occurrence": verifyReplayedOccurrence,
};

const handler = phases[phase];
if (!handler) {
  throw new Error(
    `usage: node scripts/alertmanager-http-bridge-proof.mjs <${Object.keys(phases).join("|")}> [fixturePath]`,
  );
}
await handler();
