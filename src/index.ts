import {
  definePluginEntry,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";

import {
  INCIDENT_STATE_NAMESPACE,
  projectIncidentState,
} from "./state/incident-state.js";
import { createInspectMetricSnapshotTool } from "./tools/inspect-metric-snapshot.js";
import { createProposeRemediationTool } from "./tools/propose-remediation.js";
import { createQueryPrometheusTool } from "./tools/query-prometheus.js";

const plugin: OpenClawPluginDefinition = definePluginEntry({
  id: "dataops-guardian",
  name: "DataOps Guardian",
  description: "Persists incident workflow state for DataOps investigations.",
  register(api) {
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
