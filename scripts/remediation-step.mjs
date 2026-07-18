const step = process.argv[2];
const alertId = process.env.LOBSTER_ARG_ALERT_ID;
const metric = process.env.LOBSTER_ARG_METRIC;
const action = process.env.LOBSTER_ARG_ACTION;

const allowedActions = new Set([
  "rollback_latest_release",
  "hold_deployments_and_increase_observation",
  "no_change_continue_observation",
]);

if (!new Set(["prepare", "execute", "recovery"]).has(step)) {
  throw new Error(
    "usage: node scripts/remediation-step.mjs <prepare|execute|recovery>",
  );
}
if (!alertId || !metric || !action || !allowedActions.has(action)) {
  throw new Error("invalid or missing incident remediation arguments");
}

const output =
  step === "prepare"
    ? {
        step,
        alertId,
        metric,
        action,
        preview: `Synthetic execution plan: ${action} for ${alertId}.`,
        mutatesProduction: false,
      }
    : step === "execute"
      ? {
          step,
          alertId,
          action,
          executed: true,
          mutatesProduction: false,
          summary: `Synthetic remediation ${action} executed successfully.`,
        }
      : {
          step,
          alertId,
          metric,
          healthy: true,
          summary: `${metric} recovered in the synthetic post-remediation check.`,
        };

process.stdout.write(`${JSON.stringify(output)}\n`);
