FROM ghcr.io/openclaw/openclaw:2026.6.34@sha256:47d342bafe83bd3b2dca6f1d8d8b608ba7b542a1952564960648943346206759 AS openclaw

FROM openclaw AS guardian-build
USER root
RUN install -d -o node -g node -m 0755 /build/dataops-guardian
WORKDIR /build/dataops-guardian
COPY --chown=node:node package.json package-lock.json tsconfig.json tsconfig.runtime.json ./
COPY --chown=node:node scripts/build-runtime.mjs ./scripts/build-runtime.mjs
COPY --chown=node:node src ./src
USER node
RUN npm ci --include=dev --ignore-scripts --engine-strict --no-audit --no-fund
RUN npm run build:runtime

FROM openclaw AS guardian-runtime-dependencies
USER root
RUN install -d -o node -g node -m 0755 /build/dataops-guardian-runtime
WORKDIR /build/dataops-guardian-runtime
COPY --chown=node:node container/package.json ./package.json
COPY --chown=node:node container/package-lock.json ./package-lock.json
USER node
RUN npm ci --omit=dev --omit=peer --ignore-scripts --engine-strict --no-audit --no-fund

FROM openclaw AS guardian-runtime
ARG GUARDIAN_SOURCE_REVISION
ARG GUARDIAN_VERSION

USER root
WORKDIR /opt/dataops-guardian
COPY --from=guardian-build --chown=root:root /build/dataops-guardian/dist-runtime ./dist
COPY --from=guardian-runtime-dependencies --chown=root:root /build/dataops-guardian-runtime/node_modules ./node_modules
COPY --chown=root:root package.json openclaw.plugin.json LICENSE ./
COPY --chown=root:root workflows/incident-remediation.lobster ./workflows/incident-remediation.lobster
COPY --chown=root:root scripts/remediation-step.mjs ./scripts/remediation-step.mjs
COPY --chown=root:root container/entrypoint.sh container/runtime-contract.mjs container/openclaw.container.example.json ./container/

# External plugins resolve `openclaw/plugin-sdk/*` from their host. Keep one
# OpenClaw runtime/SDK instance by linking the exact digest-pinned host package
# instead of installing a second copy below the Guardian plugin root.
RUN ln -s /app ./node_modules/openclaw && \
    test "$(node --version)" = "v24.16.0" && \
    install -d -o node -g node -m 0700 /var/lib/dataops-guardian && \
    chmod 0555 ./container/entrypoint.sh && \
    node ./container/runtime-contract.mjs write-metadata \
      "$GUARDIAN_VERSION" "$GUARDIAN_SOURCE_REVISION" && \
    chmod -R a+rX,a-w /opt/dataops-guardian && \
    node ./container/runtime-contract.mjs verify-image

LABEL org.opencontainers.image.title="OpenClaw DataOps Guardian" \
      org.opencontainers.image.description="Evidence-gated Guardian plugin bundle for dedicated OpenClaw Gateway and Alertmanager Bridge roles" \
      org.opencontainers.image.source="https://github.com/YingzuoLiu/openclaw-dataops-guardian" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${GUARDIAN_VERSION}" \
      org.opencontainers.image.revision="${GUARDIAN_SOURCE_REVISION}" \
      io.openclaw.version="2026.6.34" \
      io.openclaw.node-version="24.16.0" \
      io.openclaw.source-revision="5c38f996d4059ebd9080cf74dc611ec3a17f4d50" \
      io.openclaw.guardian.roles="gateway,bridge"

# The upstream image probes the Gateway on 18789. That check is invalid for
# the Bridge role in this dual-role image; 6B supplies workload-specific
# Kubernetes probes instead of allowing a false-unhealthy Bridge container.
HEALTHCHECK NONE

USER node
ENTRYPOINT ["tini", "-s", "--", "/opt/dataops-guardian/container/entrypoint.sh"]
CMD ["gateway"]
