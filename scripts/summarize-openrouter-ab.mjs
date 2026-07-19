import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const resultDir = process.argv[2];
if (!resultDir) {
  throw new Error("usage: summarize-openrouter-ab <result-dir>");
}

const trialsDir = join(resultDir, "trials");
const names = (await readdir(trialsDir, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const trials = await Promise.all(
  names.map(async (name) =>
    JSON.parse(await readFile(join(trialsDir, name, "summary.json"), "utf8")),
  ),
);

function aggregate(selected) {
  const count = selected.length;
  const sum = (field) => selected.filter((trial) => trial[field] === true).length;
  return {
    trials: count,
    toolCompliant: sum("requiredToolsSucceeded"),
    unsupportedConclusions: sum("unsupportedConclusionReleased"),
    blockedReports: sum("reportsBlocked"),
    failOpenObserved: sum("failOpenObserved"),
    gateReviseDecisions: selected.reduce(
      (total, trial) => total + Number(trial.gateReviseDecisionCount ?? 0),
      0,
    ),
    honoredRevisions: selected.reduce(
      (total, trial) => total + Number(trial.honoredRevisionCount ?? 0),
      0,
    ),
    modelCalls: selected.reduce((total, trial) => total + trial.modelCalls, 0),
    costUsd: selected.reduce(
      (total, trial) => total + Number(trial.usage?.costUsd ?? 0),
      0,
    ),
  };
}

const arms = Object.fromEntries(
  ["baseline", "gated"].map((arm) => [
    arm,
    aggregate(trials.filter((trial) => trial.arm === arm)),
  ]),
);
const scenarios = Object.fromEntries(
  [...new Set(trials.map((trial) => trial.scenario))].sort().map((scenario) => [
    scenario,
    {
      baseline: aggregate(
        trials.filter(
          (trial) => trial.scenario === scenario && trial.arm === "baseline",
        ),
      ),
      gated: aggregate(
        trials.filter(
          (trial) => trial.scenario === scenario && trial.arm === "gated",
        ),
      ),
    },
  ]),
);
const aggregateResult = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  trialCount: trials.length,
  totalCostUsd: trials.reduce(
    (total, trial) => total + Number(trial.usage?.costUsd ?? 0),
    0,
  ),
  arms,
  scenarios,
  trials: trials.map((trial) => ({
    trialId: trial.trialId,
    arm: trial.arm,
    scenario: trial.scenario,
    requiredToolsSucceeded: trial.requiredToolsSucceeded,
    gateReviseDecisionCount: trial.gateReviseDecisionCount,
    honoredRevisionCount: trial.honoredRevisionCount,
    unsupportedConclusionReleased: trial.unsupportedConclusionReleased,
    failOpenObserved: trial.failOpenObserved,
    costUsd: trial.usage?.costUsd ?? 0,
  })),
};

const rate = (value, total) =>
  total === 0 ? "n/a" : `${((value / total) * 100).toFixed(1)}%`;
const lines = [
  "# OpenRouter independent-trial A/B result",
  "",
  `Generated: ${aggregateResult.generatedAt}`,
  "",
  `Trials: ${trials.length}; recorded cost: $${aggregateResult.totalCostUsd.toFixed(6)}.`,
  "",
  "| Arm | Trials | Tool compliant | Unsupported conclusion | Blocked report | Honored revisions | Fail-open |",
  "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ...["baseline", "gated"].map((arm) => {
    const value = arms[arm];
    return `| ${arm} | ${value.trials} | ${value.toolCompliant} (${rate(value.toolCompliant, value.trials)}) | ${value.unsupportedConclusions} (${rate(value.unsupportedConclusions, value.trials)}) | ${value.blockedReports} | ${value.honoredRevisions} | ${value.failOpenObserved} |`;
  }),
  "",
  "This is a small behavioral evaluation, not a statistical guarantee. Automatic",
  "classification is preserved beside the raw prompt, transcript, Tool trace, and",
  "Hook JSONL so conclusions can be manually adjudicated.",
  "",
];

await writeFile(
  join(resultDir, "summary.json"),
  `${JSON.stringify(aggregateResult, null, 2)}\n`,
  "utf8",
);
await writeFile(join(resultDir, "report.md"), `${lines.join("\n")}\n`, "utf8");
process.stdout.write(`${JSON.stringify(aggregateResult)}\n`);
