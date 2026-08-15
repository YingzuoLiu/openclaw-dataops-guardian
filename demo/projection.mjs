import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEMO_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPORT_PATH = join(
  DEMO_ROOT,
  "artifacts",
  "validated-final-proof.json",
);
const DEFAULT_PROVENANCE_PATH = join(
  DEMO_ROOT,
  "artifacts",
  "provenance.json",
);

function assert(condition, message) {
  if (!condition) {
    throw new Error(`demo projection rejected source: ${message}`);
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function titleCase(value) {
  return String(value)
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function sourceEvent({
  id,
  phase,
  title,
  outcome,
  summary,
  jsonPointers,
  sourceJson,
  evidenceClass = "direct_artifact_field",
}) {
  return {
    id,
    phase,
    title,
    outcome,
    summary,
    evidenceClass,
    jsonPointers,
    sourceJson,
  };
}

function requireDisplayFields(report) {
  assert(report?.schemaVersion === 1, "unsupported proof schemaVersion");
  assert(report?.ok === true, "proof artifact is not accepted");
  assert(
    report?.proof === "dataops-guardian-final-demo",
    "unexpected proof identifier",
  );
  assert(
    typeof report?.source?.commit === "string" &&
      /^[0-9a-f]{40}$/.test(report.source.commit),
    "source commit is not a full lowercase Git SHA",
  );

  const requiredSections = [
    report.fast,
    report?.live?.environment,
    report?.live?.ingress,
    report?.live?.approval,
    report?.live?.authorization,
    report?.live?.mutation,
    report?.live?.recovery,
    report?.live?.replayProtection,
    report?.live?.cleanup,
  ];
  assert(
    requiredSections.every(
      (section) => section !== null && typeof section === "object",
    ),
    "one or more display source sections are missing",
  );
}

export function buildDemoProjection(report, provenance) {
  requireDisplayFields(report);
  assert(
    provenance?.classification === "sanitized_ci_kind_proof",
    "provenance classification is not a sanitized CI/kind proof",
  );
  assert(
    provenance.sourceCommit === report.source.commit,
    "provenance and report source commits differ",
  );

  const { fast, live } = report;
  const sourceCommit = report.source.commit;
  const shortCommit = sourceCommit.slice(0, 8);

  const events = [
    sourceEvent({
      id: "alert-ingress",
      phase: "01 · Ingress",
      title: "Alertmanager firing accepted",
      outcome: live.ingress.firingDisposition,
      summary:
        "The authenticated webhook created durable incident lifecycle state. The webhook itself contributed no metric evidence.",
      jsonPointers: [
        "$.live.ingress.firingDisposition",
        "$.live.ingress.webhookMetricEvidenceCount",
      ],
      sourceJson: {
        firingDisposition: live.ingress.firingDisposition,
        webhookMetricEvidenceCount:
          live.ingress.webhookMetricEvidenceCount,
      },
    }),
    sourceEvent({
      id: "deduplication",
      phase: "02 · State",
      title: "Duplicate alert folded into the occurrence",
      outcome: live.ingress.replayDisposition,
      summary:
        "Replaying the same firing was classified as duplicate instead of creating a second remediation path.",
      jsonPointers: ["$.live.ingress.replayDisposition"],
      sourceJson: {
        replayDisposition: live.ingress.replayDisposition,
      },
    }),
    sourceEvent({
      id: "prometheus-evidence",
      phase: "03 · Evidence",
      title: "Prometheus evidence arrived through Gateway Tools",
      outcome: live.ingress.evidenceThroughGatewayTools
        ? "tool-backed"
        : "not-observed",
      summary:
        "The proof distinguishes alert transport from read-only operational evidence: metric evidence came through registered Gateway Tools.",
      jsonPointers: [
        "$.live.ingress.evidenceThroughGatewayTools",
        "$.live.ingress.webhookMetricEvidenceCount",
      ],
      sourceJson: {
        evidenceThroughGatewayTools:
          live.ingress.evidenceThroughGatewayTools,
        webhookMetricEvidenceCount:
          live.ingress.webhookMetricEvidenceCount,
      },
    }),
    sourceEvent({
      id: "evidence-gate",
      phase: "04 · Safety gate",
      title: "Evidence Gate released the supported path",
      outcome:
        fast.policyRegistration && live.ingress.evidenceThroughGatewayTools
          ? "passed"
          : "not-observed",
      summary:
        "This is a presentation of core-produced decisions. The Console does not rerun or reinterpret the Evidence Gate.",
      jsonPointers: [
        "$.fast.policyRegistration",
        "$.fast.liveAgentFinalizeGate",
        "$.live.ingress.evidenceThroughGatewayTools",
      ],
      sourceJson: {
        policyRegistration: fast.policyRegistration,
        liveAgentFinalizeGate: fast.liveAgentFinalizeGate,
        evidenceThroughGatewayTools:
          live.ingress.evidenceThroughGatewayTools,
      },
    }),
    sourceEvent({
      id: "human-approval",
      phase: "05 · Human gate",
      title: "Lobster approval resumed the workflow",
      outcome: live.approval.approvedWorkflowStatus,
      summary:
        "A real Lobster run/resume path approved the proof occurrence. Replay controls on this page are not production approval controls.",
      jsonPointers: ["$.live.approval.approvedWorkflowStatus"],
      sourceJson: {
        approvedWorkflowStatus:
          live.approval.approvedWorkflowStatus,
      },
    }),
    sourceEvent({
      id: "allowlist-boundary",
      phase: "06 · Authority gate",
      title: "Allowlist boundary constrained mutation authority",
      outcome: live.authorization.offTargetBlockedBy,
      summary:
        "The paired live observations show an off-target request blocked at the allowlist gate and exactly one dispatch on the authorized proof path.",
      evidenceClass: "paired_artifact_observation",
      jsonPointers: [
        "$.live.authorization.offTargetBlocked",
        "$.live.authorization.offTargetBlockedBy",
        "$.live.mutation.dispatchCount",
      ],
      sourceJson: {
        offTargetBlocked: live.authorization.offTargetBlocked,
        offTargetBlockedBy:
          live.authorization.offTargetBlockedBy,
        authorizedPathDispatchCount: live.mutation.dispatchCount,
      },
    }),
    sourceEvent({
      id: "rollback",
      phase: "07 · Mutation",
      title: "Kubernetes rollback dispatched exactly once",
      outcome: live.mutation.rollbackDecision,
      summary:
        "The disposable kind Deployment changed on the authorized path; immediate and post-restart replays remained duplicates.",
      jsonPointers: [
        "$.live.mutation.rollbackDecision",
        "$.live.mutation.dispatchCount",
        "$.live.mutation.immediateReplayDecision",
        "$.live.mutation.postRestartReplayDecision",
      ],
      sourceJson: {
        rollbackDecision: live.mutation.rollbackDecision,
        dispatchCount: live.mutation.dispatchCount,
        generationChanged: live.mutation.generationChanged,
        immediateReplayDecision:
          live.mutation.immediateReplayDecision,
        postRestartReplayDecision:
          live.mutation.postRestartReplayDecision,
      },
    }),
    sourceEvent({
      id: "deployment-ready",
      phase: "08 · Recovery",
      title: "Audited Deployment readiness passed",
      outcome: live.recovery.deploymentHealthy ? "ready" : "not-ready",
      summary:
        "The recovered workload was healthy on the audited rollback template. A separate scale-to-zero probe remained not recovered.",
      jsonPointers: [
        "$.live.recovery.deploymentHealthy",
        "$.live.recovery.scaleToZeroDeploymentHealthy",
      ],
      sourceJson: {
        deploymentHealthy: live.recovery.deploymentHealthy,
        scaleToZeroDeploymentHealthy:
          live.recovery.scaleToZeroDeploymentHealthy,
      },
    }),
    sourceEvent({
      id: "fresh-signal",
      phase: "09 · Recovery",
      title: "Fresh Prometheus recovery signal passed",
      outcome: live.recovery.prometheusHealthy ? "fresh + passing" : "failed",
      summary:
        "The artifact records a passing metric and recovered decision. Under the linked proof contract, that decision is withheld unless the sample is strictly post-remediation and within the administrator-owned freshness window.",
      evidenceClass: "artifact_field_plus_proof_contract",
      jsonPointers: [
        "$.live.recovery.prometheusHealthy",
        "$.live.recovery.recoveredMetricValue",
        "$.live.recovery.threshold",
        "$.live.recovery.finalDecision",
      ],
      sourceJson: {
        prometheusHealthy: live.recovery.prometheusHealthy,
        recoveredMetricValue: live.recovery.recoveredMetricValue,
        threshold: live.recovery.threshold,
        finalDecision: live.recovery.finalDecision,
      },
    }),
    sourceEvent({
      id: "recovered",
      phase: "10 · Durable result",
      title: "Incident completed and survived restart",
      outcome: live.recovery.finalDecision,
      summary:
        "Both recovery signals passed, the persistence boundary read back completed state, and a fresh process blocked recovery replay.",
      jsonPointers: [
        "$.live.recovery.incidentCompleted",
        "$.live.recovery.completionReadbackConfirmed",
        "$.live.replayProtection.completedStateSurvivedRestart",
        "$.live.replayProtection.recoveryReplayBlockedAfterRestart",
      ],
      sourceJson: {
        incidentCompleted: live.recovery.incidentCompleted,
        completionReadbackConfirmed:
          live.recovery.completionReadbackConfirmed,
        completedStateSurvivedRestart:
          live.replayProtection.completedStateSurvivedRestart,
        recoveryReplayBlockedAfterRestart:
          live.replayProtection.recoveryReplayBlockedAfterRestart,
      },
    }),
  ];

  const failClosedScenarios = [
    {
      id: "approval-denied",
      gate: "Approval",
      title: "Denied means zero mutation",
      outcome: live.approval.deniedIncidentStage,
      summary:
        "The live deny path was cancelled at approval_gate and dispatched no Kubernetes mutation.",
      jsonPointers: [
        "$.live.approval.deniedWorkflowStatus",
        "$.live.approval.deniedBlockedBy",
        "$.live.approval.deniedMutationDispatchCount",
      ],
      sourceJson: {
        deniedWorkflowStatus: live.approval.deniedWorkflowStatus,
        deniedIncidentStage: live.approval.deniedIncidentStage,
        deniedBlockedBy: live.approval.deniedBlockedBy,
        deniedMutationDispatchCount:
          live.approval.deniedMutationDispatchCount,
      },
    },
    {
      id: "off-target",
      gate: "Allowlist",
      title: "Off-target request blocked",
      outcome: live.authorization.offTargetBlockedBy,
      summary:
        "The allowlisted Deployment fingerprint stayed unchanged when the proof requested another target.",
      jsonPointers: [
        "$.live.authorization.offTargetBlocked",
        "$.live.authorization.offTargetBlockedBy",
      ],
      sourceJson: {
        offTargetBlocked: live.authorization.offTargetBlocked,
        offTargetBlockedBy:
          live.authorization.offTargetBlockedBy,
      },
    },
    {
      id: "unhealthy-recovery",
      gate: "Recovery",
      title: "Readiness failure cannot complete",
      outcome: live.recovery.scaleToZeroDecision,
      summary:
        "Scaling the proof Deployment to zero kept readiness false and the incident incomplete.",
      jsonPointers: [
        "$.live.recovery.scaleToZeroDecision",
        "$.live.recovery.scaleToZeroDeploymentHealthy",
        "$.live.recovery.scaleToZeroIncidentCompleted",
      ],
      sourceJson: {
        scaleToZeroDecision: live.recovery.scaleToZeroDecision,
        scaleToZeroDeploymentHealthy:
          live.recovery.scaleToZeroDeploymentHealthy,
        scaleToZeroIncidentCompleted:
          live.recovery.scaleToZeroIncidentCompleted,
      },
    },
  ];

  return {
    schemaVersion: 1,
    mode: "sanitized-proof-replay",
    banner: "Demo mode — sanitized proof replay",
    valueStatement:
      "Guardian turns an operational alert into an evidence-backed, human-approved, replay-safe rollback—and will not call it recovered until both infrastructure and application signals agree.",
    replayNotice:
      "This is a fast visual projection of aggregate, sanitized proof fields—not a timestamped event log and not a live Kubernetes operation.",
    provenance: {
      classification: provenance.classification,
      label: "Validated GitHub Actions full-safety-proof artifact",
      artifactName: provenance.artifactName,
      artifactCreatedAt: provenance.artifactCreatedAt,
      workflowRunNumber: provenance.workflowRunNumber,
      workflowUrl: provenance.workflowUrl,
      sourceCommit,
      shortCommit,
      commitUrl: `https://github.com/YingzuoLiu/openclaw-dataops-guardian/commit/${sourceCommit}`,
      documentationUrl: `https://github.com/YingzuoLiu/openclaw-dataops-guardian/blob/${sourceCommit}/docs/final-safety-proof.md`,
      reportSha256: provenance.validatedReportSha256,
      environment: [
        live.environment.kindCluster ? "disposable kind" : "kind not observed",
        live.environment.realPrometheus
          ? "real Prometheus"
          : "Prometheus not observed",
        live.environment.realLobster
          ? "real Lobster"
          : "Lobster not observed",
      ],
    },
    incident: {
      reference: "Sanitized proof occurrence",
      identifier: "Withheld by the validated artifact contract",
      status: titleCase(live.recovery.finalDecision),
      deduplication: `${live.ingress.firingDisposition} → ${live.ingress.replayDisposition}`,
      mutationDispatches: live.mutation.dispatchCount,
      recovery: "Deployment readiness + fresh Prometheus signal",
    },
    gates: [
      {
        id: "evidence",
        label: "Evidence",
        state:
          fast.policyRegistration && live.ingress.evidenceThroughGatewayTools
            ? "passed"
            : "not-observed",
        revealAt: "evidence-gate",
        detail: "Tool-backed Prometheus evidence; webhook evidence count 0",
      },
      {
        id: "approval",
        label: "Approval",
        state: live.approval.approvedWorkflowStatus,
        revealAt: "human-approval",
        detail: "Real Lobster run/resume proof",
      },
      {
        id: "allowlist",
        label: "Allowlist",
        state: live.authorization.offTargetBlocked
          ? "enforced"
          : "not-observed",
        revealAt: "allowlist-boundary",
        detail: "Off-target live probe blocked at allowlist_gate",
      },
    ],
    recoveryChecks: [
      {
        id: "deployment",
        label: "Deployment Ready",
        state: live.recovery.deploymentHealthy ? "passed" : "failed",
        revealAt: "deployment-ready",
        detail: "Audited rollback template is healthy",
      },
      {
        id: "prometheus",
        label: "Fresh Signal",
        state: live.recovery.prometheusHealthy ? "passed" : "failed",
        revealAt: "fresh-signal",
        detail: `${live.recovery.recoveredMetricValue} ≥ ${live.recovery.threshold}`,
      },
    ],
    events,
    failClosedScenarios,
    audit: {
      title: "Validated sanitized proof JSON",
      description:
        "This is the exact checked-in CI report. Raw audit.jsonl, credentials, internal paths, target identifiers, and timestamped component logs were intentionally not retained in the validated artifact.",
      sourceJson: report,
    },
  };
}

export async function loadDemoProjection({
  reportPath = DEFAULT_REPORT_PATH,
  provenancePath = DEFAULT_PROVENANCE_PATH,
} = {}) {
  const [reportBytes, provenanceBytes] = await Promise.all([
    readFile(reportPath),
    readFile(provenancePath),
  ]);
  const report = JSON.parse(reportBytes.toString("utf8"));
  const provenance = JSON.parse(provenanceBytes.toString("utf8"));

  assert(
    sha256(reportBytes) === provenance.validatedReportSha256,
    "validated report SHA-256 does not match provenance",
  );

  return buildDemoProjection(report, provenance);
}
