import { jsonResult } from "openclaw/plugin-sdk/core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

import { runKubernetesProbe } from "./spike.mjs";

const plugin = definePluginEntry({
  id: "guardian-day0-kind-connectivity",
  name: "Guardian Day 0 kind Connectivity Spike",
  description:
    "Disposable OpenClaw plugin used only to verify kind access and a reversible allowlisted write.",
  register(api) {
    api.registerTool({
      name: "guardian_day0_kind_connectivity",
      label: "Guardian Day 0 kind Connectivity",
      description:
        "Read or reversibly annotate the one statically allowlisted Day 0 Deployment.",
      parameters: Type.Object(
        {
          action: Type.Union([
            Type.Literal("read"),
            Type.Literal("patch_and_restore"),
          ]),
          namespace: Type.String({ minLength: 1, maxLength: 63 }),
          deployment: Type.String({ minLength: 1, maxLength: 253 }),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId, params) => {
        try {
          return jsonResult(
            await runKubernetesProbe({
              rawConfig: api.pluginConfig,
              ...params,
            }),
          );
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.includes("static allowlist")
          ) {
            return jsonResult({
              action: "denied",
              denied: true,
              reason: "static_allowlist",
              requestedTarget: `${params.namespace}/${params.deployment}`,
            });
          }
          throw error;
        }
      },
    });

    api.registerToolMetadata({
      toolName: "guardian_day0_kind_connectivity",
      displayName: "Guardian Day 0 kind Connectivity",
      description:
        "Spike-only Kubernetes read and reversible annotation patch for one fixed Deployment.",
      risk: "high",
      tags: ["dataops", "kubernetes", "spike-only", "mutating"],
    });
  },
});

export default plugin;
