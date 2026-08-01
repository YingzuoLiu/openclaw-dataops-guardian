import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  INCIDENT_STATE_NAMESPACE,
  projectIncidentState,
  readIncidentStateV3,
} from "./state/incident-state.js";
import { evaluateIncidentEvidence } from "./policy/evidence-policy.js";
import {
  activateGuardianRunEvidence,
  buildGuardianGateAuditEvent,
  buildProposalToolGateDecision,
  buildResponseGateDecision,
  GUARDIAN_RUN_CONTEXT_NAMESPACE,
  type GuardianRunEvidence,
  recordGuardianToolObservation,
  resolveGuardianRequireToolsMode,
  shouldEnforceGuardianRequireTools,
} from "./hooks/response-gate.js";
import { createInspectMetricSnapshotTool } from "./tools/inspect-metric-snapshot.js";
import { createProposeRemediationTool } from "./tools/propose-remediation.js";
import { createQueryPrometheusTool } from "./tools/query-prometheus.js";

export {
  isRestartReconciliationManualReview,
  reconcileIncidentOnRestart,
  type DeferredDeliveryRecovery,
  type ExternalReconciliationOutcome,
  type ExternalReconciliationRequest,
  type ExternalRemediationReconciler,
  type RestartReconciliationResult,
} from "./state/restart-reconciliation.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "dataops-guardian",
  name: "DataOps Guardian",
  description: "Persists incident workflow state for DataOps investigations.",
  register(api) {
    const fallbackRunEvidence = new Map<string, GuardianRunEvidence>();
    const fallbackWarnings = new Set<string>();

    const logGateAudit = (
      event: ReturnType<typeof buildGuardianGateAuditEvent>,
    ): void => {
      api.logger.info(JSON.stringify(event));
    };

    const readRunEvidence = (runId: string): GuardianRunEvidence | undefined =>
      (api.runContext.getRunContext({
        runId,
        namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
      }) as GuardianRunEvidence | undefined) ?? fallbackRunEvidence.get(runId);

    const storeRunEvidence = (
      runId: string,
      value: GuardianRunEvidence,
    ): void => {
      const stored = api.runContext.setRunContext({
        runId,
        namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
        value,
      });
      if (stored) {
        fallbackRunEvidence.delete(runId);
        fallbackWarnings.delete(runId);
        return;
      }

      fallbackRunEvidence.delete(runId);
      fallbackRunEvidence.set(runId, value);
      if (!fallbackWarnings.has(runId)) {
        api.logger.warn(
          `[dataops-guardian] host run context rejected a write; using bounded in-process fallback run=${runId}`,
        );
        fallbackWarnings.add(runId);
      }
      while (fallbackRunEvidence.size > 512) {
        const oldestRunId = fallbackRunEvidence.keys().next().value;
        if (oldestRunId === undefined) {
          break;
        }
        fallbackRunEvidence.delete(oldestRunId);
        fallbackWarnings.delete(oldestRunId);
      }
    };

    api.registerTool(createInspectMetricSnapshotTool());
    api.registerTool(createProposeRemediationTool());
    api.registerTool(createQueryPrometheusTool(api.pluginConfig));
    api.registerToolMetadata({
      toolName: "guardian_inspect_metric_snapshot",
      displayName: "Inspect Metric Snapshot",
      description: "Classify one metric snapshot against its expected baseline.",
      risk: "low",
      tags: ["dataops", "investigation", "read-only"],
    });
    api.registerToolMetadata({
      toolName: "guardian_query_prometheus",
      displayName: "Query Prometheus",
      description:
        "Run a read-only instant query against the configured Prometheus endpoint.",
      risk: "low",
      tags: ["dataops", "prometheus", "monitoring", "read-only"],
    });
    api.registerToolMetadata({
      toolName: "guardian_propose_remediation",
      displayName: "Propose Remediation",
      description:
        "Create a deterministic remediation proposal without executing it.",
      risk: "low",
      tags: ["dataops", "proposal", "read-only"],
    });

    api.on(
      "before_agent_run",
      (_event, ctx) => {
        if (!shouldEnforceGuardianRequireTools(api.pluginConfig)) {
          return;
        }
        if (!ctx.runId) {
          return {
            outcome: "block" as const,
            reason: "Guardian require_tools could not identify the active run",
            message: "Guardian validation could not initialize this run.",
            category: "guardian_validator_state",
          };
        }

        const current = readRunEvidence(ctx.runId);
        const next = activateGuardianRunEvidence(current);
        storeRunEvidence(ctx.runId, next);
        logGateAudit(
          buildGuardianGateAuditEvent({
            state: next,
            hook: "before_agent_run",
            runId: ctx.runId,
            decision: "activate",
          }),
        );
      },
      { priority: 100, timeoutMs: 1_000 },
    );

    api.on(
      "before_tool_call",
      (event, ctx) => {
        const requireToolsMode = resolveGuardianRequireToolsMode(
          api.pluginConfig,
        );
        const runId = event.runId ?? ctx.runId;
        let runEvidence;
        if (runId && requireToolsMode !== "disabled") {
          const current = readRunEvidence(runId);
          runEvidence = recordGuardianToolObservation(current, {
            toolName: event.toolName,
            succeeded: false,
          });
          if (runEvidence) {
            storeRunEvidence(runId, runEvidence);
          }
        }

        if (event.toolName !== "guardian_propose_remediation") {
          return;
        }
        const runDecision =
          requireToolsMode === "disabled"
            ? undefined
            : buildProposalToolGateDecision(runEvidence);
        if (runId && runDecision) {
          logGateAudit(
            buildGuardianGateAuditEvent({
              state: runEvidence,
              hook: "before_tool_call",
              runId,
              decision: "block",
            }),
          );
          return runDecision;
        }

        const incident = ctx.getSessionExtension?.(INCIDENT_STATE_NAMESPACE);
        if (incident !== undefined) {
          const decoded = readIncidentStateV3(incident);
          if (!decoded.ok) {
            return {
              block: true,
              blockReason: `remediation proposal cannot read incident state: ${decoded.error}`,
            };
          }
          const validation = evaluateIncidentEvidence(
            decoded.state,
            new Date().toISOString(),
          );
          if (!validation.ok) {
            return {
              block: true,
              blockReason: `remediation proposal failed evidence policy: ${validation.issues.join("; ")}`,
            };
          }
        }
      },
      { priority: 100, timeoutMs: 1_000 },
    );

    api.on(
      "after_tool_call",
      (event, ctx) => {
        if (
          resolveGuardianRequireToolsMode(api.pluginConfig) === "disabled"
        ) {
          return;
        }
        const runId = event.runId ?? ctx.runId;
        if (!runId) {
          return;
        }
        const current = readRunEvidence(runId);
        const next = recordGuardianToolObservation(current, {
          toolName: event.toolName,
          succeeded: !event.error,
        });
        if (next) {
          storeRunEvidence(runId, next);
        }
      },
      { priority: 100, timeoutMs: 1_000 },
    );

    api.on(
      "before_agent_finalize",
      (event, ctx) => {
        if (
          resolveGuardianRequireToolsMode(api.pluginConfig) === "disabled"
        ) {
          return;
        }
        const runId = event.runId ?? ctx.runId;
        if (!runId) {
          return;
        }
        let runEvidence = readRunEvidence(runId);
        if (
          runEvidence === undefined &&
          shouldEnforceGuardianRequireTools(api.pluginConfig)
        ) {
          runEvidence = activateGuardianRunEvidence(undefined);
          storeRunEvidence(runId, runEvidence);
        }
        const decision = buildResponseGateDecision(runEvidence);
        if (runEvidence !== undefined) {
          logGateAudit(
            buildGuardianGateAuditEvent({
              state: runEvidence,
              hook: "before_agent_finalize",
              runId,
              decision: decision ? "revise" : "allow",
            }),
          );
        }
        return decision;
      },
      { priority: 100, timeoutMs: 1_000 },
    );

    api.on(
      "agent_end",
      (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) {
          return;
        }
        fallbackRunEvidence.delete(runId);
        fallbackWarnings.delete(runId);
        api.runContext.clearRunContext({
          runId,
          namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
        });
      },
      { priority: 100, timeoutMs: 1_000 },
    );

    api.session.state.registerSessionExtension({
      namespace: INCIDENT_STATE_NAMESPACE,
      description:
        "Small JSON-compatible state for the active DataOps incident workflow.",
      project: ({ state }) => projectIncidentState(state),
      cleanup: ({ reason, sessionKey }) => {
        api.logger.info(
          `[dataops-guardian] session state cleanup reason=${reason} session=${sessionKey ?? "all"}`,
        );
      },
    });
  },
});

export default plugin;
