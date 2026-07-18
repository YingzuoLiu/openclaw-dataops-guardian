import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  INCIDENT_STATE_NAMESPACE,
  projectIncidentState,
} from "./state/incident-state.js";
import { evaluateIncidentEvidence } from "./policy/evidence-policy.js";
import {
  activateGuardianRunEvidence,
  buildGuardianGateAuditEvent,
  buildProposalToolGateDecision,
  buildResponseGateDecision,
  GUARDIAN_RUN_CONTEXT_NAMESPACE,
  recordGuardianToolObservation,
  shouldEnforceGuardianRequireTools,
} from "./hooks/response-gate.js";
import { createInspectMetricSnapshotTool } from "./tools/inspect-metric-snapshot.js";
import { createProposeRemediationTool } from "./tools/propose-remediation.js";
import { createQueryPrometheusTool } from "./tools/query-prometheus.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "dataops-guardian",
  name: "DataOps Guardian",
  description: "Persists incident workflow state for DataOps investigations.",
  register(api) {
    const logGateAudit = (
      event: ReturnType<typeof buildGuardianGateAuditEvent>,
    ): void => {
      api.logger.info(JSON.stringify(event));
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

        const current = api.runContext.getRunContext({
          runId: ctx.runId,
          namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
        });
        const next = activateGuardianRunEvidence(current);
        const stored = api.runContext.setRunContext({
          runId: ctx.runId,
          namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
          value: next,
        });
        if (!stored) {
          return {
            outcome: "block" as const,
            reason: "Guardian require_tools run context was rejected",
            message: "Guardian validation could not initialize this run.",
            category: "guardian_validator_state",
          };
        }
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
        const runId = event.runId ?? ctx.runId;
        let runEvidence;
        if (runId) {
          const current = api.runContext.getRunContext({
            runId,
            namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
          });
          runEvidence = recordGuardianToolObservation(current, {
            toolName: event.toolName,
            succeeded: false,
          });
          if (runEvidence) {
            api.runContext.setRunContext({
              runId,
              namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
              value: runEvidence,
            });
          }
        }

        if (event.toolName !== "guardian_propose_remediation") {
          return;
        }
        const runDecision = buildProposalToolGateDecision(runEvidence);
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
          const validation = evaluateIncidentEvidence(
            incident,
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
        const runId = event.runId ?? ctx.runId;
        if (!runId) {
          return;
        }
        const current = api.runContext.getRunContext({
          runId,
          namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
        });
        const next = recordGuardianToolObservation(current, {
          toolName: event.toolName,
          succeeded: !event.error,
        });
        if (next) {
          api.runContext.setRunContext({
            runId,
            namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
            value: next,
          });
        }
      },
      { priority: 100, timeoutMs: 1_000 },
    );

    api.on(
      "before_agent_finalize",
      (event, ctx) => {
        const runId = event.runId ?? ctx.runId;
        if (!runId) {
          return;
        }
        let runEvidence = api.runContext.getRunContext({
          runId,
          namespace: GUARDIAN_RUN_CONTEXT_NAMESPACE,
        });
        if (
          runEvidence === undefined &&
          shouldEnforceGuardianRequireTools(api.pluginConfig)
        ) {
          runEvidence = activateGuardianRunEvidence(undefined);
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
