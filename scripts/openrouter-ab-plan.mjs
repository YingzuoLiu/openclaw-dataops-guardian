import {
  buildPrompt,
  buildTrialPlan,
  getScenario,
} from "../evals/openrouter-ab/scenarios.mjs";

const mode = process.argv[2] ?? "smoke";
const format = process.argv[3] ?? "human";
const plan = buildTrialPlan(mode).map((trial, index) => ({
  ...trial,
  ordinal: index + 1,
  id: `${String(index + 1).padStart(2, "0")}-${trial.scenario}-r${trial.replicate}-${trial.arm}`,
  delayMs: getScenario(trial.scenario).delayMs,
  promptChars: buildPrompt(trial.scenario, trial.replicate).length,
}));

if (format === "tsv") {
  for (const trial of plan) {
    process.stdout.write(
      [
        trial.id,
        trial.scenario,
        trial.replicate,
        trial.arm,
        trial.delayMs,
      ].join("\t") + "\n",
    );
  }
} else {
  process.stdout.write(
    `${JSON.stringify({
      mode,
      independentTrials: plan.length,
      pairedInputs: true,
      order: "deterministic counterbalanced",
      modelDefault: "openrouter/openai/gpt-4.1-mini",
      maxOutputTokensPerModelCall: 512,
      plan,
    }, null, 2)}\n`,
  );
}
