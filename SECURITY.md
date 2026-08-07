# Security policy

## Supported versions

DataOps Guardian is a prototype. Security fixes are applied to the latest
`0.1.x` release line only. It is not approved for unattended production
remediation.

## Reporting a vulnerability

Do not disclose credentials or exploit details in a public issue. Prefer
GitHub private vulnerability reporting from the repository's **Security** tab.
If private reporting is unavailable, open a minimal issue asking the maintainer
for a private contact channel without including sensitive details.

Include the affected Guardian and OpenClaw versions, operating system, install
method, reproduction steps, and the smallest sanitized log that demonstrates
the issue. Remove API keys, authorization headers, session transcripts,
internal hostnames, and production metric values.

## Security boundaries in `v0.1.0`

- Prometheus access is read-only and the endpoint is administrator-owned.
- Credentials embedded in `prometheusBaseUrl` are rejected.
- Bearer-token, mTLS, and cloud-provider authentication are not implemented.
- Kubernetes mutation is limited to a configured cluster context and exact
  namespace/Deployment allowlist; callers cannot supply a kubeconfig, API
  server, arbitrary patch, or shell command.
- Recovery requires the same succeeded attempt binding, matching Deployment
  UID/template/audit annotations, ready replicas, and a fresh
  administrator-owned Prometheus threshold check.
- The Agent response gate is bounded and can fail open after its revision
  budget; durable Reducer and Tool gates are the action boundary.
- Local proof scripts bind fixtures to loopback, use isolated state and kind
  clusters, and remove temporary credentials and clusters on exit. They must
  never be pointed at a normal Gateway profile or production cluster.

Operators remain responsible for network isolation, OpenClaw channel and Tool
permissions, secret storage, log retention, and review of any future
production-mutating integration.
