# Alertmanager HTTP bridge

Step 2b adds an external HTTP receiver that terminates real Alertmanager
webhook traffic and drives the existing ingestion boundary
(`canonicalizeAlertmanagerWebhook`, `planAlertDeliveryIngestion`) against a
running OpenClaw Gateway. It is deliberately a standalone process, not an
OpenClaw plugin capability.

## Boundary

```text
Alertmanager
  -> POST /v1/alertmanager/webhook (bridge, loopback by default)
  -> canonicalizeAlertmanagerWebhook / planAlertDeliveryIngestion (unchanged)
  -> Gateway RPC (sessions.create / sessions.describe / sessions.pluginPatch)
  -> IncidentState v3 session (the only durable copy of incident state)
```

The bridge is independent of OpenClaw plugin registration: it never calls
`definePluginEntry`/`register()` and is not listed in `openclaw.extensions`.
It talks to the Gateway the same way any other operator client does — over
`GatewayClient` RPC — from `src/alertmanager/http-bridge/run.ts`
(`dist/alertmanager/http-bridge/run.js` once built). The Gateway process
still needs the `dataops-guardian` plugin installed, exactly as today, purely
because `sessions.pluginPatch` requires an active registration for the
`dataops-guardian/incident` session extension namespace — the bridge itself
registers nothing.

The bridge holds exactly three pieces of local state, under
`ALERTMANAGER_BRIDGE_STATE_DIR`, in two separate files:

- **fingerprint → occurrence/session route** and **deferred checkpoints**
  (`src/alertmanager/http-bridge/bridge-state.ts`) live together in one
  versioned JSON file, `bridge-state.json`:
  - the route is a pointer to which Gateway session currently owns a
    fingerprint's incident state — never a copy of `IncidentState` itself,
    since every planning decision re-reads the current state from the
    Gateway session immediately before acting;
  - a checkpoint (one per fingerprint) holds the exact canonical delivery
    `planAlertDeliveryIngestion` could not route yet.
- **sanitized audit records** (`src/alertmanager/http-bridge/audit.ts`) are a
  *separate* file, `audit.jsonl`, in the same state directory — appended
  independently of `bridge-state.json` and never embedded inside it.

## Occurrence routing

`applyDelivery` (`src/alertmanager/http-bridge/processor.ts`) resolves each
canonical delivery to the occurrence it actually belongs to in two phases,
in this order:

1. **The delivery's own deterministic occurrence is checked first**, before
   ever consulting the fingerprint's route. `occurrenceId`/`sessionKey` are
   pure functions of `fingerprint` + `startsAt` (unchanged from Step 2), so
   this is a direct `sessions.describe` on that exact session — independent
   of whatever the fingerprint's route currently points at. If that session
   already holds state, the delivery is reduced directly against *it*
   (`reduceAlertDelivery(ownState, delivery)`), and the resulting state is
   persisted back — preserving whatever `stage`/`evidence`/`approvalStatus`/
   `remediationAttempts` it already had. This is what makes it safe for a
   delivery to target an occurrence that isn't the fingerprint's currently
   active one: a delayed retry for a historical occurrence, a delayed
   `resolved` delivery for an occurrence that already exists (correctly
   *not* orphaned), or a checkpoint replay resuming after a crash between an
   earlier destination write and its route commit (see the crash-window
   table below) all go through this same path, and none of them can
   overwrite real state with a freshly-created `alert_received` one.
2. **Only once step 1 confirms the delivery's own occurrence does not exist
   yet** does the bridge fall back to `planAlertDeliveryIngestion` against
   the fingerprint's *active* route — exactly the "is anything currently
   running that must block this new occurrence" question the reducer
   already answers correctly for the active occurrence.

Two guards apply across both phases:

- **The active route only ever moves forward.** Before advancing a
  fingerprint's route to a different occurrence, the bridge compares the
  candidate's `startsAt` against the *current* route's own `startsAt` (read
  live from the Gateway, never cached) and only advances if the candidate is
  strictly newer. A delayed delivery for an occurrence older than the
  active one is persisted to its own session but never moves the route
  backward. This same comparison is what lets a checkpoint replay resuming
  after a crash *complete* an interrupted forward move rather than being
  blocked by it.
- **A fingerprint holds at most one deferred checkpoint, and a conflicting
  one is rejected, not overwritten.** If a fingerprint already has a durably
  held checkpoint and a *different* delivery (`deliveryId` mismatch) would
  also need to defer, the bridge throws `CheckpointConflictError`
  (`src/alertmanager/http-bridge/errors.ts`) instead of silently discarding
  the first one — the HTTP layer maps this to `503`, so Alertmanager retries
  once the held delivery has been resolved. Re-holding the *same*
  `deliveryId` (Alertmanager's own repeat-send, or a replay drain re-checking
  an unresolved checkpoint) is treated as an idempotent rewrite, not a
  conflict.

## Consistency: fail closed, never silently recreate

Every place the bridge is about to trust "no state exists here, safe to
create fresh" first confirms that with a live Gateway read, and every state
it reads back is checked for *identity*, not just internal validity — that
it is actually the state for the fingerprint/occurrence the bridge asked
for, not merely some other well-formed `IncidentState`. `readIncidentStateV3`
alone cannot catch that: it only proves a value is internally
self-consistent (its own `occurrenceId` matches its own `fingerprint` +
`startsAt`), not that it is the value stored under the key the bridge
expected. The following throw `BridgeConsistencyError` instead of
proceeding:

- **A route points at a session the Gateway no longer has**, or whose value
  fails `readIncidentStateV3`. A route the bridge itself created must always
  resolve to a valid session; a miss means the session was deleted or reset
  externally, storage was corrupted, or the route is simply wrong.
  Recreating from scratch would fabricate a new `alert_received` occurrence
  over whatever that destination might still hold once it is available
  again, which is exactly the class of bug this guards against.
- **A route's destination session decodes, but its identity doesn't match
  the route.** `describeRouteStateStrict` additionally requires
  `state.fingerprint === fingerprint`, `state.occurrenceId ===
  route.occurrenceId`, and `route.sessionKey ===
  incidentSessionKey(state.occurrenceId)`. A mismatch means the route points
  at the wrong session (e.g. two fingerprints' routes colliding on one
  session key through corruption) — a decodable-but-wrong value must not be
  treated as authoritative for the fingerprint asking for it.
- **A destination session's value exists but fails to decode.** Same
  reasoning as the route case, regardless of whether a route currently
  points there.
- **A delivery's own deterministic destination session decodes, but its
  identity doesn't match the delivery.** Symmetric to the route check:
  before reducing a delivery against its own destination session's existing
  state (see "Occurrence routing" above), the bridge requires
  `state.fingerprint === delivery.fingerprint`, `state.occurrenceId` equal
  to the delivery's own deterministic `occurrenceId`, and `state.startsAt
  === delivery.startsAt`. Any single one of these checks failing is enough
  to reject; only when both are already implied by the other two does the
  third become effectively redundant, and it is kept anyway as a defense
  against a `createIncidentOccurrenceId` hash collision. All three fail
  closed to `503`, never to an ordinary reducer `rejected` outcome — an
  identity mismatch is a bridge-state/Gateway inconsistency, not a
  malformed-delivery response the caller should see as a normal per-alert
  result.

`BridgeStateStore` (`bridge-state.ts`) applies the same fail-closed posture
to its own file:

- **An existing-but-empty `bridge-state.json` is treated as corrupted, not
  as "nothing persisted yet."** Only a genuinely missing file is the
  legitimate fresh-start case; `readJsonFileOrUndefined`
  (`json-store.ts`) lets `JSON.parse` throw for anything else, and the
  bridge refuses to start rather than silently reinitializing over lost
  routes/checkpoints.
- **Cross-field validation on load**: every checkpoint's held delivery must
  be a structurally valid `AlertDelivery`, and additionally pass the same
  delivery-contract validation `reduceAlertDelivery` itself enforces at
  runtime (timestamp validity, `receivedAt >= startsAt`, `firing` requiring
  `endsAt: null`, `resolved` requiring a valid `endsAt >= startsAt`) —
  reused directly (`reduceAlertDelivery(undefined, delivery)`, checking the
  decision isn't `rejected`) rather than re-implemented, so the two can
  never drift apart. A checkpoint's `checkpointId` must equal
  `computeDeferredAlertDeliveryCheckpointId(blockedByOccurrenceId,
  delivery.deliveryId)` — the exact same exported computation
  `planAlertDeliveryIngestion` uses (`ingestion.ts`), not a second copy of
  the hash. A checkpoint filed under fingerprint `F` must hold a delivery
  whose own `fingerprint` is `F`. **A checkpoint must have a corresponding
  route** — a checkpoint only ever exists because some active occurrence's
  running remediation attempt is blocking a newer delivery, so a route for
  that fingerprint always exists at the moment the checkpoint is created,
  and nothing removes it while the checkpoint survives; a checkpoint with no
  route is not "a fresh fingerprint with a held delivery" but corruption,
  and treating it as the former on startup would route the held delivery as
  a brand new occurrence, silently bypassing the very remediation attempt
  `blockedByOccurrenceId` was recording. When both a route and a checkpoint
  exist for the same fingerprint, the checkpoint's `blockedByOccurrenceId`
  must match the route's `occurrenceId`. A route's `sessionKey` must equal
  `incidentSessionKey(occurrenceId)` — never an independently stored value
  that could drift from it.

## Concurrency and consistency across writers

`FingerprintLock` only serializes work *inside this one bridge process* for
the *same fingerprint*; it says nothing about a different process writing to
the same Gateway session concurrently — an operator, a restart-reconciliation
coordinator, or an Agent workflow acting on an occurrence the bridge also
touches. Whether that race is actually preventable depends on what the
Gateway RPC itself supports:

**`sessions.pluginPatch` has no compare-and-swap.** Checked directly against
the installed `openclaw@2026.6.9` RPC schema
(`SessionsPluginPatchParamsSchema` in `node_modules/openclaw/dist/schema-*.js`):
the accepted parameters are exactly `key`, `pluginId`, `namespace`, `value`,
`unset`, with `additionalProperties: false` — there is no revision, `etag`,
or expected-version field the Gateway would even accept, so there is no way
for a caller to make a patch conditional on the session being unchanged
since it was last read. This bridge does not claim otherwise.

Concretely, the following is possible and is *not* prevented by anything in
this codebase: the bridge describes a session, an external writer patches it
(e.g. records a remediation attempt result), and the bridge's own
`sessions.pluginPatch` — computed from the now-stale value it described —
overwrites that write. This is a real gap, not a hypothetical one, and it is
explicitly out of scope for Step 2b to close: doing so would require either
a Gateway-side primitive that does not currently exist, or a single-writer
architecture spanning more than the bridge (restart reconciliation,
Lobster/Agent remediation-attempt lifecycle writes, and the bridge itself
would all need to funnel through one serialization point). A future step
should either add optimistic concurrency to `sessions.pluginPatch` upstream,
or establish the bridge as incident state's single writer and route every
other actor's mutations through it. Until then, deployments should avoid
running the bridge alongside another process that patches the same
`dataops-guardian/incident` sessions concurrently.

## Security properties

- **Binds to `127.0.0.1` by default.** `ALERTMANAGER_BRIDGE_HOST` can
  override this, but the default is loopback-only; exposing the receiver
  beyond loopback is an explicit operator decision, not the out-of-the-box
  behavior.
- **Bearer token required, constant-time comparison.** Every request must
  carry `Authorization: Bearer <token>`. `src/alertmanager/http-bridge/auth.ts`
  hashes both the presented and configured token to a fixed-length SHA-256
  digest before calling `crypto.timingSafeEqual`, so neither a length
  mismatch nor a content mismatch is distinguishable through timing.
- **`application/json` required**, exact match ignoring a `;charset=...`
  suffix; anything else is rejected with `415` before the body is read.
- **Fixed request size limit** (`MAX_REQUEST_BODY_BYTES` = 1 MiB,
  `src/alertmanager/http-bridge/config.ts`), enforced while the body streams
  in — an oversized body is rejected with `413` before it is ever fully
  buffered, and is never operator-configurable (a fixed bound is part of the
  bridge's DoS posture, not a per-deployment tuning knob).
- **The receiver stamps its own `receivedAt`.** `canonicalizeAlertmanagerWebhook`
  is called with the bridge's own `Date.now()`; nothing from the untrusted
  payload is ever trusted as ingress time (unchanged from Step 2's contract).
- **No raw webhook, labels, annotations, or bearer token is ever logged.**
  `AuditEvent` (`src/alertmanager/http-bridge/audit.ts`) is a closed,
  explicit-field union — `fingerprint` and `deliveryId` are retained because
  the rest of this codebase already treats them as safe identifiers
  (`fingerprint` is Alertmanager's own label-set hash, not label content;
  `deliveryId` is a derived digest — see docs/alertmanager-ingestion.md).
  There is no code path that appends the parsed payload, `labels`,
  `annotations`, or the `Authorization` header to any log or audit record.
  This includes the envelope-level `webhook_received` record every
  successfully canonicalized webhook produces (`receiver`, `groupStatus`,
  `truncatedAlerts`, `acceptedCount`, `rejectedCount` only) — deliberately
  excluding `groupKey`, which embeds label *values* (e.g.
  `{}:{alertname="X"}`) even though it is otherwise just envelope metadata.
- **Per-fingerprint serialization within one process.** `FingerprintLock`
  (`src/alertmanager/http-bridge/fingerprint-lock.ts`) chains async work per
  fingerprint, so two deliveries for the same fingerprint in the same bridge
  process never interleave. This is a single-instance guarantee only — see
  Explicit exclusions.
- **Correct path, wrong method returns `405`, not `404`.** Only
  `req.url !== ALERTMANAGER_WEBHOOK_PATH` is `404`; a non-`POST` request to
  the correct path gets `405` with an `Allow: POST` header, matching normal
  HTTP semantics instead of conflating "wrong endpoint" with "wrong verb".

## Durability contract

- **Bridge state is versioned JSON, written durably.**
  `src/alertmanager/http-bridge/json-store.ts` writes to a sibling temp file,
  `fsync`s it, `rename`s it over the destination (atomic on the same
  filesystem), then `fsync`s the containing directory. A reader can never
  observe a partially written `bridge-state.json`.
- **A deferred checkpoint is durable before the HTTP response.**
  `processCanonicalAlertDelivery` calls `BridgeStateStore.setCheckpoint`
  (a synchronous durable flush) before returning to the HTTP handler, which
  only then sends `2xx`. If the process is killed between accepting the
  socket and that flush, no response was ever sent, so Alertmanager retries
  and nothing is lost.
- **The destination `IncidentState` and the route must both be durable
  before a checkpoint is cleared.** `commitRouteAndClearCheckpoint`
  (`bridge-state.ts`) performs the route update and the checkpoint removal in
  one flush, and is only called *after* `gateway.persistIncidentState` has
  already succeeded (verified via echo-equality against the Gateway's
  response). A crash between the Gateway write and this flush is the
  documented crash window below.
- **Persistence failure never returns `2xx`.** Every Gateway RPC failure
  (unreachable Gateway, timeout, echo mismatch) surfaces as
  `GatewayPersistenceError`, which the HTTP layer maps to `503` — Alertmanager
  retries, and no partial state was durably committed for that alert.
- **A checkpoint can be replayed against the same `deliveryId` safely.**
  Replay always re-runs the *ordinary* processing pipeline
  (`applyDelivery`/`drainPendingCheckpoint` in `processor.ts`), re-deriving
  the outcome from live Gateway state rather than trusting anything cached
  locally — it is not a special code path. If the blocking attempt is still
  running, the checkpoint is simply rewritten with identical content. If it
  has settled, the delivery is *not* unconditionally applied through
  `reduceAlertDelivery(undefined, delivery)`: `applyDelivery` first checks
  whether the delivery's own deterministic destination session already
  exists (see "Occurrence routing" above) — it does whenever an earlier
  replay attempt got as far as the destination write before being
  interrupted — and if so reduces against *that* real state instead. Either
  way the result is deterministic: a redundant replay of an already-durable
  delivery reproduces the same state rather than double-counting it (see
  docs/alertmanager-ingestion.md's delivery-identity contract), and never
  discards progress a prior interrupted replay's destination write already
  made durable.
- **A `running` remediation attempt survives a bridge restart as `held`.**
  The bridge never starts, cancels, or investigates a remediation attempt.
  On startup, `run.ts` sweeps every pending checkpoint through
  `drainPendingCheckpoint`; if the blocking attempt is still `running`, the
  sweep leaves the checkpoint exactly as it was. Settling a `running` attempt
  remains the job of a separate restart-reconciliation coordinator (see
  `docs/incident-state-v3.md`), outside this bridge's scope.

### Crash windows

| Window | What survives | What is retried |
|---|---|---|
| Killed before the socket accepts a request | Nothing was acknowledged | Alertmanager retries the whole delivery |
| Killed after body read, before Gateway/checkpoint write | No `2xx` was sent | Alertmanager retries; the retry re-plans from scratch |
| Killed after `hold_deferred_delivery`'s checkpoint flush, before `2xx` is written | Checkpoint is durable on disk | Alertmanager may retry (harmless — re-planning reproduces the same checkpoint); on bridge restart, the checkpoint is loaded and still held |
| Killed after the Gateway write for `persist_new_occurrence` (replay), before `commitRouteAndClearCheckpoint` | Destination `IncidentState` is durable on the Gateway; checkpoint and route are unchanged | On restart, the startup sweep replays the same checkpoint delivery again; because occurrence routing always re-checks the delivery's own destination session first (see "Occurrence routing" above), the replay reduces against the state that is actually there — including anything an external workflow added to it after the interrupted write — rather than overwriting it with a fresh one; the route/checkpoint flush that didn't complete before now does |
| Gateway restarts while the bridge stays up | `IncidentState` is unaffected (Gateway session persistence, proven in `docs/proof-2-session-extension.md`) | The bridge's `GatewayClient` reconnects; in-flight requests during the outage return `503` |

The crash-window proof (`scripts/alertmanager-http-bridge-crash-proof.mjs`)
exercises the fourth row directly, including the destination-overwrite
guard: after the destination write under test, it further advances that
newly created session (adds evidence, changes `stage`) to simulate a
workflow that legitimately acted on it before the crash, kills the process
with `SIGKILL` before the checkpoint clears, then asserts recovery clears
the checkpoint, moves the route, does not double-count the replayed
delivery, *and* that the externally added evidence/stage survived the
replay rather than being reset to a fresh `alert_received` state.

## Explicit exclusions

This step does not add:

- Kubernetes access of any kind;
- rollback execution;
- a remediation executor or remediation cancellation;
- automatic Agent/investigation dispatch;
- multiple bridge replicas, a distributed lock, a database, or a message
  queue — the bridge is a single process with one local JSON file, and
  `FingerprintLock` only serializes work *within* that one process;
- automatic compensation for `orphan_resolved` deliveries (unchanged
  residual risk from docs/alertmanager-ingestion.md — a `resolved` delivery
  that arrives before its matching `firing` delivery is still audited and
  dropped, with no durable replay channel);
- automatic re-fetch of alerts Alertmanager dropped because of
  `truncatedAlerts` (still an audit-only signal, unchanged from Step 2).

A fingerprint's checkpoint slot is also singular by design: only the most
recently deferred delivery for a fingerprint is retained, mirroring
`reduceAlertDelivery`'s own single-current-occurrence model. This is a
deliberate scope bound, not a queue — see the reducer's contract in
`docs/incident-state-v3.md`.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ALERTMANAGER_BRIDGE_HOST` | no | `127.0.0.1` | bind address |
| `ALERTMANAGER_BRIDGE_PORT` | no | `9187` | listen port |
| `ALERTMANAGER_BRIDGE_TOKEN` | yes | — | required bearer token |
| `ALERTMANAGER_BRIDGE_STATE_DIR` | yes | — | directory for `bridge-state.json` and `audit.jsonl` |
| `OPENCLAW_GATEWAY_URL` | yes | — | e.g. `ws://127.0.0.1:19184` |
| `OPENCLAW_GATEWAY_TOKEN` | yes | — | Gateway operator token (`operator.admin`, `operator.read`, `operator.write` scopes) |
| `ALERTMANAGER_BRIDGE_GATEWAY_REQUEST_TIMEOUT_MS` | no | `10000` | per-RPC timeout |
| `ALERTMANAGER_BRIDGE_GATEWAY_CONNECT_TIMEOUT_MS` | no | `15000` | initial connect timeout |

## Running the proof

```bash
npm run check
npm run alertmanager:http-bridge-proof
```

The proof spins up an isolated OpenClaw Gateway and bridge process (loopback
only, throwaway state directories), and covers: malformed JSON / missing or
wrong bearer token / wrong content type / oversized body / wrong method on
the correct path (`405`), partial alert rejection within one webhook, a
durable `webhook_received` audit record visible in `audit.jsonl` with
`truncatedAlerts > 0` and no raw payload/labels/annotations/token,
repeat-delivery dedup, a new `startsAt` routing to an independent occurrence,
a deferred checkpoint held while a remediation attempt is running, two
differing deferred deliveries for the same fingerprint (the first held
durably, the second rejected with `503` rather than overwriting it), a
route-regression scenario (`A firing -> B firing -> delayed A firing ->
delayed A resolved`, asserting the active route stays at B throughout and
A's own state updates correctly without ever being treated as orphaned),
`503` when the Gateway is unreachable, a Gateway restart with the bridge left
running, two bridge restarts (one while the checkpoint is still held, one
after it has been replayed), and the crash window described above (including
the destination-overwrite guard).
