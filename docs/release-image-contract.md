# Container image and source-release contract (Phase 6A)

Status: **implemented in source for `v0.3.0`**. The repository does not yet
publish a prebuilt registry image. A source tag is accepted only after the
tag-triggered fresh-clone proof succeeds; an image is accepted only after the
separate exact-commit OCI job builds and runs it successfully.

Phase 6A makes Guardian installable without turning its evidence-gated safety
prototype into a production platform. It defines how one immutable artifact is
built and how it starts two dedicated process roles. Kubernetes Deployments,
RBAC, NetworkPolicy, Secret delivery, role-specific probes, high availability,
and registry publication remain separate work.

## Pinned runtime

| Component | Contract |
|---|---|
| Guardian | `0.3.0`, built from the full 40-character source commit |
| OpenClaw host | `2026.6.34` |
| Node.js in the fixed base | `24.16.0` |
| OpenClaw source revision | `5c38f996d4059ebd9080cf74dc611ec3a17f4d50` |
| Official base image | `ghcr.io/openclaw/openclaw:2026.6.34@sha256:47d342bafe83bd3b2dca6f1d8d8b608ba7b542a1952564960648943346206759` |
| Lobster | `2026.6.34` |
| Image platform proven by CI | `linux/amd64` |

The manifest digest is the image identity. The human-readable tag is retained
for clarity but is not trusted by itself. Guardian declares OpenClaw as a host
peer and links to the one `/app` runtime supplied by the official image; it
does not carry a second OpenClaw SDK tree.

## Build from an exact source commit

Prerequisites are Git, Bash, Node.js in Guardian's supported range, npm, and a
working Docker daemon with pull access:

```bash
git clone --branch v0.3.0 --depth 1 \
  https://github.com/YingzuoLiu/openclaw-dataops-guardian.git
cd openclaw-dataops-guardian
npm ci
npm run check
npm run container:build -- dataops-guardian:0.3.0
```

The build wrapper requires a clean committed worktree, resolves the exact
`HEAD`, exports that Git object into a private temporary context, and passes its
version and revision into the image build. A local ignored `dist/`, `.env`,
`.npmrc`, kubeconfig, or `node_modules/` directory is therefore not a build
input. The Dockerfile independently uses explicit `COPY` statements and
compiles a runtime-only tree with no tests, declarations, or source maps.

To exercise the actual image contract instead of only building it:

```bash
npm run container:proof
```

The proof builds `linux/amd64`, inspects the effective user, entrypoint,
healthcheck and OCI metadata, verifies the installed Node/OpenClaw/Guardian/
Lobster versions, starts both roles, runtime-inspects five Guardian Tools and
five typed Hooks, proves an arbitrary Lobster shell pipeline is blocked, and
runs the immutable approval workflow across a complete Gateway restart. It
also checks negative startup/state/credential cases and searches a saved image
for a host-only sentinel. The proof deletes its containers, network, volumes,
and local image tag before returning a sanitized JSON report.

## Runtime layout

Guardian is baked into `/opt/dataops-guardian`, outside OpenClaw's writable
state home. This matters because mounting `/home/node/.openclaw` must not hide
the plugin. The image explicitly loads both immutable roots:

- `/opt/dataops-guardian`;
- `/opt/dataops-guardian/node_modules/@openclaw/lobster`.

The working directory is `/opt/dataops-guardian` so the Lobster workflow can
resolve `workflows/incident-remediation.lobster` and
`scripts/remediation-step.mjs`. The process runs as the upstream `node` user
(UID 1000) under `tini`; the dispatcher ends with `exec` and never evaluates
operator input through `sh -c`.

The image performs no install, `git`, `curl`, or package download at startup.
Configuration, credentials, and state are runtime inputs and must not be baked
into an image layer.

## Gateway role

The Gateway role requires all of the following before OpenClaw starts:

| Input | Requirement |
|---|---|
| `OPENCLAW_CONFIG_PATH` | Absolute path to strict JSON; plugin paths/allowlist must contain only baked Guardian/Lobster, both must be enabled, both Guardian gates must be active, and `tools.allow` must contain only those six tools |
| `OPENCLAW_GATEWAY_TOKEN` | Non-empty operator token; pass it through a secret mechanism |
| `OPENCLAW_STATE_DIR` | Absolute writable state directory; durable write/sync/remove is probed |
| `LOBSTER_STATE_DIR` | Absolute writable resume-state directory; place it on persistent storage |

The checked-in example contains no secret, provider key, Prometheus URL, or
Kubernetes authority. For a local isolated profile:

```bash
docker network create guardian-local
docker volume create guardian-gateway-state

read -rsp "Gateway token: " OPENCLAW_GATEWAY_TOKEN
printf '\n'
export OPENCLAW_GATEWAY_TOKEN

docker run -d --rm --name guardian-gateway \
  --network guardian-local --network-alias gateway \
  -p 127.0.0.1:18789:18789 \
  -p 127.0.0.1:9187:9187 \
  -e OPENCLAW_CONFIG_PATH=/opt/dataops-guardian/container/openclaw.container.example.json \
  -e OPENCLAW_GATEWAY_TOKEN \
  -e OPENCLAW_STATE_DIR=/home/node/.openclaw \
  -e LOBSTER_STATE_DIR=/home/node/.openclaw/lobster-state \
  -e OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 \
  --mount type=volume,source=guardian-gateway-state,target=/home/node/.openclaw \
  dataops-guardian:0.3.0 gateway run \
    --port 18789 --bind lan --auth token --allow-unconfigured
```

Missing Prometheus or Kubernetes configuration does not block this baseline
startup. The corresponding Guardian capabilities remain unavailable and fail
closed when called until an administrator supplies their configuration.
Keeping `LOBSTER_STATE_DIR` below the mounted OpenClaw state volume preserves
pending approval/resume tokens across Gateway container replacement.

The profile deliberately exposes the optional `lobster` Tool only behind
Guardian's `incident_workflow_only` hook. Raw Lobster can otherwise execute
shell pipelines with the Gateway environment. The hook blocks run-identified
OpenClaw Agent Tool calls, rejects inline or alternate pipelines from
authenticated non-Agent loopback RPC, and accepts a resume token only when its
persisted state names the immutable baked workflow. This is not caller
authentication: any process given the Gateway operator token has operator
authority and can approve that exact workflow. Never expose the token to
model-controlled code, and do not disable this policy in a release profile.

## Bridge role

The standalone Bridge requires these inputs before it connects to the Gateway
or opens its HTTP listener:

| Input | Requirement |
|---|---|
| `ALERTMANAGER_BRIDGE_TOKEN` | Bearer token required from every webhook caller; must differ from the Gateway token |
| `OPENCLAW_GATEWAY_URL` | Credential-free loopback `ws://` or `wss://` URL; Bridge uses OpenClaw's local backend protocol |
| `OPENCLAW_GATEWAY_TOKEN` | Gateway operator token |
| `ALERTMANAGER_BRIDGE_STATE_DIR` | Absolute writable state/audit directory; durably probed |
| `ALERTMANAGER_BRIDGE_HOST` | Optional; defaults to container loopback |
| `ALERTMANAGER_BRIDGE_PORT` | Optional canonical integer `1..65535`; defaults to `9187` |

The Bridge's OpenClaw client intentionally has no remote device identity. It
must share the Gateway's network namespace and connect over loopback; a normal
cross-container hostname is not an authenticated substitute. When exposing the
Bridge through a Docker-published port, binding it to `0.0.0.0` inside that
shared namespace is an explicit trust-boundary decision. The Gateway example
publishes that port only on host loopback. Start the Bridge in the Gateway
container's network namespace:

```bash
docker volume create guardian-bridge-state

read -rsp "Alertmanager bridge token: " ALERTMANAGER_BRIDGE_TOKEN
printf '\n'
export ALERTMANAGER_BRIDGE_TOKEN

docker run --rm --name guardian-bridge \
  --network container:guardian-gateway \
  -e ALERTMANAGER_BRIDGE_HOST=0.0.0.0 \
  -e ALERTMANAGER_BRIDGE_PORT=9187 \
  -e ALERTMANAGER_BRIDGE_TOKEN \
  -e ALERTMANAGER_BRIDGE_STATE_DIR=/var/lib/dataops-guardian \
  -e OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789 \
  -e OPENCLAW_GATEWAY_TOKEN \
  --mount type=volume,source=guardian-bridge-state,target=/var/lib/dataops-guardian \
  dataops-guardian:0.3.0 bridge
```

Docker's `container:guardian-gateway` mode binds the Bridge to that specific
Gateway container's network namespace. If the Gateway container is replaced,
recreate the Bridge as part of the same operation; it does not follow the name
to a new namespace. Phase 6B must avoid this Docker lifecycle coupling, for
example by using one Kubernetes Pod network namespace or another supported
authenticated machine-identity design.

The Bridge rejects unknown positional arguments. A missing secret, invalid URL,
unwritable/corrupt state, or unreachable Gateway causes a non-zero exit before
the receiver is considered available.

## Health and orchestration boundary

The official OpenClaw base image has a Gateway-only Docker healthcheck against
port 18789. That check would permanently mark the same image's Bridge role
unhealthy, so Phase 6A explicitly sets `HEALTHCHECK NONE`.

For manual Gateway checks, use its `/healthz` and `/readyz` endpoints, and use
`openclaw plugins inspect ... --runtime` to prove plugin registration. The
Bridge currently has no role-aware health endpoint. Phase 6B must define
separate workload probes instead of inheriting one image-level check.

## Source tags and registry publication

The release history assigns the pre-image baseline to `v0.2.0` at commit
`4cc109e852431e2e3bb02eefd3a604a645a6ab4c`. Maintainers must create and verify
that immutable remote tag before publishing `v0.3.0`; otherwise the changelog
comparison base and documented compatibility history are broken. Neither tag
may be moved after publication.

`npm run release:source-proof -- v0.3.0` accepts only an exact semantic-version
tag that already exists on the remote. It resolves annotated tags to their
commit, creates a fresh shallow clone, checks tag/package agreement, runs
`npm ci` and the build, verifies the linked Guardian/Lobster install, five
Tools, five Hooks, and zero loader diagnostics in an isolated OpenClaw profile,
then runs the immutable approval flow across a complete Gateway restart.

A pull request cannot prove that a future remote tag exists or will remain on
the intended commit. The tag-triggered CI job is therefore post-publication
acceptance. Likewise, the current source does not push a registry image and
does not claim a GHCR digest. If registry publication is added, consumers
should pull the accepted artifact by digest and repeat its runtime and metadata
checks before deployment.
