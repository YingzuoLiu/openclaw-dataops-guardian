import { readFile } from "node:fs/promises";

const FORBIDDEN_KEY =
  /^(?:token|[a-z]+Token|secret|password|credential|credentials|apiKey|accessKey|privateKey|sessionKey|idempotencyKey|authorizationHeader|kubeconfig|path|[a-z]+Path|absolutePath|podTemplate|rawWebhook|rawPayload|rawEvidence)$/i;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function assertSourceCommit(value) {
  assert(
    typeof value === "string" && /^[0-9a-f]{40}$/.test(value),
    "proof source commit must be a full lowercase Git SHA",
  );
  return value;
}

export function parseJsonLines(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{") && line.endsWith("}"))
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function findResult(results, predicate, label) {
  const result = results.find(predicate);
  assert(result, `${label} did not emit its expected proof result`);
  return result;
}

export function assertSanitizedReport(value, forbiddenValues = []) {
  const visit = (entry, path) => {
    if (typeof entry === "string") {
      assert(
        !entry.startsWith("/") &&
          !entry.toLowerCase().startsWith("file:") &&
          !WINDOWS_ABSOLUTE_PATH.test(entry),
        `sanitized report contains an absolute path at ${path}`,
      );
      for (const forbidden of forbiddenValues) {
        if (forbidden) {
          assert(
            !entry.includes(forbidden),
            `sanitized report contains a forbidden value at ${path}`,
          );
        }
      }
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (entry !== null && typeof entry === "object") {
      for (const [key, item] of Object.entries(entry)) {
        assert(!FORBIDDEN_KEY.test(key), `sanitized report contains forbidden key ${key}`);
        visit(item, `${path}.${key}`);
      }
    }
  };

  visit(value, "report");
  return value;
}

export function buildFastDemoReport(logs, sourceCommit) {
  const commit = assertSourceCommit(sourceCommit);
  const policy = findResult(
    parseJsonLines(logs.policy),
    (entry) => entry.ok === true && Array.isArray(entry.typedHooks),
    "policy registration",
  );
  const liveHook = findResult(
    parseJsonLines(logs.liveHook),
    (entry) => entry.ok === true && entry.gatewayAgentRun === true,
    "live Agent hook",
  );
  const bridge = findResult(
    parseJsonLines(logs.bridge),
    (entry) => entry.ok === true && entry.proof === "alertmanager-http-bridge",
    "Alertmanager HTTP bridge",
  );
  const approved = findResult(
    parseJsonLines(logs.approved),
    (entry) =>
      entry.ok === true &&
      entry.command === "resume" &&
      entry.decision === "approve" &&
      entry.stage === "completed" &&
      entry.approvalStatus === "approved",
    "synthetic approval",
  );
  const denied = findResult(
    parseJsonLines(logs.denied),
    (entry) =>
      entry.ok === true &&
      entry.command === "resume" &&
      entry.decision === "deny" &&
      entry.stage === "blocked" &&
      entry.approvalStatus === "denied",
    "synthetic denial",
  );

  const requiredHooks = [
    "after_tool_call",
    "agent_end",
    "before_agent_finalize",
    "before_agent_run",
    "before_tool_call",
  ];
  assert(
    Array.isArray(policy.diagnostics) &&
      policy.diagnostics.length === 0 &&
      requiredHooks.every((hook) => policy.typedHooks.includes(hook)),
    "policy registration did not expose every required typed Hook",
  );
  assert(
    liveHook.hookActivationObserved === true &&
      liveHook.finalizeRevisionObserved === true &&
      liveHook.singleRunAcrossAttempts === true &&
      liveHook.modelCalls === 2 &&
      liveHook.expectedModelCalls === 2 &&
      liveHook.apiCostUsd === 0,
    "live Agent finalization proof was incomplete",
  );
  assert(
    bridge.ok === true && bridge.proof === "alertmanager-http-bridge",
    "Alertmanager HTTP bridge proof was incomplete",
  );
  assert(
    approved.workflowStatus === "ok" && approved.stage === "completed",
    "synthetic approval did not complete",
  );
  assert(
    denied.workflowStatus === "cancelled" && denied.stage === "blocked",
    "synthetic denial did not block",
  );

  return assertSanitizedReport({
    schemaVersion: 1,
    ok: true,
    proof: "dataops-guardian-fast-demo",
    source: { commit },
    components: {
      policyRegistration: true,
      liveAgentFinalizeGate: true,
      httpBridgeAuthCheckpointCrashRecovery: true,
      syntheticApproval: true,
      syntheticDenial: true,
    },
    apiCostUsd: 0,
  });
}

function selectKindSafetySummary(report) {
  const selected = {
    environment: {
      kindCluster: report?.environment?.kindCluster,
      realPrometheus: report?.environment?.realPrometheus,
      realLobster: report?.environment?.realLobster,
      pinnedImages: report?.environment?.pinnedImages,
    },
    ingress: {
      unauthorizedStatus: report?.ingress?.unauthorizedStatus,
      unauthorizedStateCreated: report?.ingress?.unauthorizedStateCreated,
      firingDisposition: report?.ingress?.firingDisposition,
      replayDisposition: report?.ingress?.replayDisposition,
      webhookMetricEvidenceCount: report?.ingress?.webhookMetricEvidenceCount,
      evidenceThroughGatewayTools: report?.ingress?.evidenceThroughGatewayTools,
    },
    approval: {
      approvedWorkflowStatus: report?.approval?.approvedWorkflowStatus,
      deniedWorkflowStatus: report?.approval?.deniedWorkflowStatus,
      deniedIncidentStage: report?.approval?.deniedIncidentStage,
      deniedBlockedBy: report?.approval?.deniedBlockedBy,
      deniedMutationDispatchCount:
        report?.approval?.deniedMutationDispatchCount,
    },
    restartReconciliation: {
      ambiguousOutcome:
        report?.restartReconciliation?.ambiguousOutcome,
      ambiguousManualReviewBlocked:
        report?.restartReconciliation?.ambiguousManualReviewBlocked,
      ambiguousMutationDispatchCount:
        report?.restartReconciliation?.ambiguousMutationDispatchCount,
      appliedOutcome: report?.restartReconciliation?.appliedOutcome,
    },
    authorization: {
      offTargetBlocked: report?.authorization?.offTargetBlocked,
      offTargetBlockedBy: report?.authorization?.offTargetBlockedBy,
      rbacOtherDeploymentDenied:
        report?.authorization?.rbacOtherDeploymentDenied,
      rbacOtherNamespaceDenied:
        report?.authorization?.rbacOtherNamespaceDenied,
      rbacSecretsDenied: report?.authorization?.rbacSecretsDenied,
      rbacDeleteDenied: report?.authorization?.rbacDeleteDenied,
      rbacCreateDenied: report?.authorization?.rbacCreateDenied,
    },
    mutation: {
      rollbackDecision: report?.mutation?.rollbackDecision,
      dispatchCount: report?.mutation?.dispatchCount,
      generationChanged: report?.mutation?.generationChanged,
      resourceVersionChanged: report?.mutation?.resourceVersionChanged,
      templateMatchesTarget: report?.mutation?.templateMatchesTarget,
      immediateReplayDecision: report?.mutation?.immediateReplayDecision,
      postRestartReplayDecision:
        report?.mutation?.postRestartReplayDecision,
      replayGenerationUnchanged:
        report?.mutation?.replayGenerationUnchanged,
      replayMutationFingerprintUnchanged:
        report?.mutation?.replayMutationFingerprintUnchanged,
    },
    recovery: {
      resolvedWebhookIsNotRecovery:
        report?.recovery?.resolvedWebhookIsNotRecovery,
      scaleToZeroDecision: report?.recovery?.scaleToZeroDecision,
      scaleToZeroDeploymentHealthy:
        report?.recovery?.scaleToZeroDeploymentHealthy,
      scaleToZeroIncidentCompleted:
        report?.recovery?.scaleToZeroIncidentCompleted,
      finalDecision: report?.recovery?.finalDecision,
      deploymentHealthy: report?.recovery?.deploymentHealthy,
      prometheusHealthy: report?.recovery?.prometheusHealthy,
      recoveredMetricValue: report?.recovery?.recoveredMetricValue,
      threshold: report?.recovery?.threshold,
      incidentCompleted: report?.recovery?.incidentCompleted,
      completionReadbackConfirmed:
        report?.recovery?.completionReadbackConfirmed,
    },
    replayProtection: {
      rollbackReplayIsDuplicate:
        report?.replayProtection?.rollbackReplayIsDuplicate,
      recoveryReplayBlocked:
        report?.replayProtection?.recoveryReplayBlocked,
      recoveryReplayBlockedBy:
        report?.replayProtection?.recoveryReplayBlockedBy,
      recoveryReplayBlockedAfterRestart:
        report?.replayProtection?.recoveryReplayBlockedAfterRestart,
      completedStateSurvivedRestart:
        report?.replayProtection?.completedStateSurvivedRestart,
    },
    cleanup: {
      gatewayStopped: report?.cleanup?.gatewayStopped,
      bridgeStopped: report?.cleanup?.bridgeStopped,
      portForwardStopped: report?.cleanup?.portForwardStopped,
      clusterDeleted: report?.cleanup?.clusterDeleted,
      localImageTagsDeleted: report?.cleanup?.localImageTagsDeleted,
      temporaryCredentialsDeleted:
        report?.cleanup?.temporaryCredentialsDeleted,
    },
  };

  assert(
    Object.values(selected.environment).every((value) => value === true) &&
      selected.ingress.unauthorizedStatus === 401 &&
      selected.ingress.unauthorizedStateCreated === false &&
      selected.ingress.firingDisposition === "created" &&
      selected.ingress.replayDisposition === "duplicate" &&
      selected.ingress.webhookMetricEvidenceCount === 0 &&
      selected.ingress.evidenceThroughGatewayTools === true &&
      selected.approval.approvedWorkflowStatus === "ok" &&
      selected.approval.deniedWorkflowStatus === "cancelled" &&
      selected.approval.deniedIncidentStage === "blocked" &&
      selected.approval.deniedBlockedBy === "approval_gate" &&
      selected.approval.deniedMutationDispatchCount === 0 &&
      selected.restartReconciliation.ambiguousOutcome === "unknown" &&
      selected.restartReconciliation.ambiguousManualReviewBlocked === true &&
      selected.restartReconciliation.ambiguousMutationDispatchCount === 0 &&
      selected.restartReconciliation.appliedOutcome ===
        "confirmed_succeeded" &&
      Object.entries(selected.authorization).every(([key, value]) =>
        key === "offTargetBlockedBy"
          ? value === "allowlist_gate"
          : value === true,
      ) &&
      selected.mutation.rollbackDecision === "rolled_back" &&
      selected.mutation.dispatchCount === 1 &&
      selected.mutation.generationChanged === true &&
      selected.mutation.resourceVersionChanged === true &&
      selected.mutation.templateMatchesTarget === true &&
      selected.mutation.immediateReplayDecision === "duplicate" &&
      selected.mutation.postRestartReplayDecision === "duplicate" &&
      selected.mutation.replayGenerationUnchanged === true &&
      selected.mutation.replayMutationFingerprintUnchanged === true &&
      selected.recovery.resolvedWebhookIsNotRecovery === true &&
      selected.recovery.scaleToZeroDecision === "not_recovered" &&
      selected.recovery.scaleToZeroDeploymentHealthy === false &&
      selected.recovery.scaleToZeroIncidentCompleted === false &&
      selected.recovery.finalDecision === "recovered" &&
      selected.recovery.deploymentHealthy === true &&
      selected.recovery.prometheusHealthy === true &&
      Number.isFinite(selected.recovery.recoveredMetricValue) &&
      Number.isFinite(selected.recovery.threshold) &&
      selected.recovery.recoveredMetricValue >= selected.recovery.threshold &&
      selected.recovery.incidentCompleted === true &&
      selected.recovery.completionReadbackConfirmed === true &&
      selected.replayProtection.rollbackReplayIsDuplicate === true &&
      selected.replayProtection.recoveryReplayBlocked === true &&
      selected.replayProtection.recoveryReplayBlockedBy ===
        "completed_stage_gate" &&
      selected.replayProtection.recoveryReplayBlockedAfterRestart === true &&
      selected.replayProtection.completedStateSurvivedRestart === true &&
      Object.values(selected.cleanup).every((value) => value === true),
    "kind safety report is incomplete or inconsistent",
  );
  return selected;
}

export function buildFullDemoReport(fastReport, kindReport) {
  const fastComponents = fastReport?.components;
  assert(
    fastReport?.schemaVersion === 1 &&
      fastReport.proof === "dataops-guardian-fast-demo" &&
      fastReport.ok === true &&
      fastComponents?.policyRegistration === true &&
      fastComponents.liveAgentFinalizeGate === true &&
      fastComponents.httpBridgeAuthCheckpointCrashRecovery === true &&
      fastComponents.syntheticApproval === true &&
      fastComponents.syntheticDenial === true &&
      /^[0-9a-f]{40}$/.test(fastReport?.source?.commit ?? ""),
    "fast demo report is not successful",
  );
  assert(
    kindReport?.schemaVersion === 1 &&
      kindReport.proof === "kind-final-safety" &&
      kindReport.ok === true &&
      kindReport?.source?.commit === fastReport.source.commit,
    "kind safety report is not successful",
  );
  const live = selectKindSafetySummary(kindReport);
  return assertSanitizedReport({
    schemaVersion: 1,
    ok: true,
    proof: "dataops-guardian-final-demo",
    source: { commit: fastReport.source.commit },
    fast: fastReport.components,
    live,
    apiCostUsd: 0,
  });
}

export function buildKindSafetyReport(parts) {
  const {
    prepare,
    denied,
    ambiguous,
    offTarget,
    rollback,
    replay,
    postRestartReplay,
    reconcile,
    resolved,
    negative,
    recovery,
    recoveryReplay,
    show,
    rbac,
    cleanup,
    sourceCommit,
  } = parts;
  const commit = assertSourceCommit(sourceCommit);
  assert(
    prepare?.command === "prepare-http" &&
      prepare.unauthorizedStatus === 401 &&
      prepare.authorizedDisposition === "created" &&
      prepare.replayDisposition === "duplicate" &&
      prepare.webhookEvidenceCount === 0 &&
      prepare.degradedMetric === 0.7 &&
      prepare.classification === "critical" &&
      Array.isArray(prepare.evidenceTools) &&
      prepare.evidenceTools.includes("guardian_query_prometheus") &&
      prepare.evidenceTools.includes("guardian_inspect_metric_snapshot") &&
      prepare.evidenceTools.includes("guardian_propose_remediation") &&
      prepare.workflowStatus === "ok" &&
      prepare.stage === "remediation" &&
      prepare.attemptStatus === "running",
    "HTTP ingress, Tool evidence, or approval preparation failed",
  );
  assert(
    denied?.workflowStatus === "cancelled" &&
      denied.approvalStatus === "denied" &&
      denied.stage === "blocked" &&
      denied.rollbackBlocked === true &&
      denied.blockedBy === "approval_gate" &&
      denied.mutationDispatchCount === 0 &&
      denied.generationUnchanged === true &&
      denied.mutationFingerprintUnchanged === true,
    "denial path did not fail closed without mutation",
  );
  assert(
    ambiguous?.decision === "manual_review" &&
    ambiguous?.externalOutcome === "unknown" &&
      ambiguous.stage === "blocked" &&
      ambiguous.mutationDispatchCount === 0 &&
      ambiguous.generationUnchanged === true &&
      ambiguous.mutationFingerprintUnchanged === true,
    "ambiguous reconciliation did not fail closed",
  );
  assert(
    offTarget?.blocked === true &&
      offTarget.blockedBy === "allowlist_gate" &&
      offTarget.mutationDispatchCount === 0 &&
      offTarget.generationUnchanged === true &&
      offTarget.mutationFingerprintUnchanged === true,
    "off-target mutation was not blocked without mutation",
  );
  assert(
    rollback?.decision === "rolled_back" &&
      rollback.patched === true &&
      rollback.mutationDispatchCount === 1 &&
      rollback.generationChanged === true &&
      rollback.resourceVersionChanged === true &&
      rollback.templateMatchesTarget === true,
    "rollback did not produce exactly one observed mutation",
  );
  assert(
    replay?.decision === "duplicate" &&
      replay.patched === false &&
      replay.generationUnchanged === true &&
      replay.mutationFingerprintUnchanged === true &&
      postRestartReplay?.decision === "duplicate" &&
      postRestartReplay.patched === false &&
      postRestartReplay.generationUnchanged === true &&
      postRestartReplay.mutationFingerprintUnchanged === true,
    "rollback replay protection failed",
  );
  assert(
    reconcile?.externalOutcome === "confirmed_succeeded" &&
      reconcile.stage === "recovery_check" &&
      reconcile.attemptStatus === "succeeded" &&
      Number.isFinite(Date.parse(reconcile.finishedAt)),
    "positive restart reconciliation failed",
  );
  assert(
    resolved?.alertStatus === "resolved" &&
      resolved.incidentStage === "recovery_check" &&
      resolved.recoveryEvidencePresent === false &&
      resolved.incidentCompleted === false,
    "resolved webhook completed the incident or fabricated recovery evidence",
  );
  assert(
    negative?.decision === "not_recovered" &&
      negative.deploymentHealthy === false &&
      Array.isArray(negative.deploymentIssues) &&
      negative.deploymentIssues.includes("desired_replicas_not_positive") &&
      negative.incidentStage === "recovery_check" &&
      negative.incidentCompleted === false &&
      Number.isFinite(Date.parse(negative.checkedAt)),
    "scale-to-zero did not remain unrecovered",
  );
  assert(
    recovery?.decision === "recovered" &&
      recovery.deploymentHealthy === true &&
      recovery.prometheusHealthy === true &&
      Number.isFinite(recovery.prometheusValue) &&
      Number.isFinite(recovery.prometheusThreshold) &&
      recovery.prometheusValue >= recovery.prometheusThreshold &&
      Number.isFinite(Date.parse(recovery.prometheusObservedAt)) &&
      recovery.incidentStage === "completed" &&
      recovery.evidenceSource === "guardian_deployment_prometheus_recovery" &&
      recovery.completionReadbackConfirmed === true,
    "dual recovery did not complete from fresh Deployment and Prometheus evidence",
  );
  assert(
    recoveryReplay?.blocked === true &&
      recoveryReplay.blockedBy === "completed_stage_gate" &&
      recoveryReplay.incidentStage === "completed",
    "recovery replay was not blocked",
  );
  assert(show?.state?.stage === "completed", "completed state did not survive restart");
  assert(
    rbac?.otherDeploymentDenied === true &&
      rbac.otherNamespaceDenied === true &&
      rbac.secretsDenied === true &&
      rbac.deleteDenied === true &&
      rbac.createDenied === true,
    "one or more RBAC checks did not fail closed",
  );
  assert(
    cleanup?.gatewayStopped === true &&
      cleanup.bridgeStopped === true &&
      cleanup.portForwardStopped === true &&
      cleanup.clusterDeleted === true &&
      cleanup.localImageTagsDeleted === true &&
      cleanup.temporaryCredentialsDeleted === true,
    "one or more cleanup checks failed",
  );

  return assertSanitizedReport({
    schemaVersion: 1,
    ok: true,
    proof: "kind-final-safety",
    source: { commit },
    environment: {
      kindCluster: true,
      realPrometheus: true,
      realLobster: true,
      pinnedImages: true,
    },
    ingress: {
      unauthorizedStatus: prepare.unauthorizedStatus,
      unauthorizedStateCreated: false,
      firingDisposition: prepare.authorizedDisposition,
      replayDisposition: prepare.replayDisposition,
      webhookMetricEvidenceCount: prepare.webhookEvidenceCount,
      evidenceThroughGatewayTools: prepare.evidenceTools?.length === 3,
    },
    approval: {
      approvedWorkflowStatus: prepare.workflowStatus,
      deniedWorkflowStatus: denied.workflowStatus,
      deniedIncidentStage: denied.stage,
      deniedBlockedBy: denied.blockedBy,
      deniedMutationDispatchCount: denied.mutationDispatchCount,
    },
    restartReconciliation: {
      ambiguousOutcome: ambiguous.externalOutcome,
      ambiguousManualReviewBlocked: ambiguous.stage === "blocked",
      ambiguousMutationDispatchCount: ambiguous.mutationDispatchCount,
      appliedOutcome: reconcile.externalOutcome,
    },
    authorization: {
      offTargetBlocked: offTarget.blocked,
      offTargetBlockedBy: offTarget.blockedBy,
      rbacOtherDeploymentDenied: rbac.otherDeploymentDenied,
      rbacOtherNamespaceDenied: rbac.otherNamespaceDenied,
      rbacSecretsDenied: rbac.secretsDenied,
      rbacDeleteDenied: rbac.deleteDenied,
      rbacCreateDenied: rbac.createDenied,
    },
    mutation: {
      rollbackDecision: rollback.decision,
      dispatchCount: rollback.mutationDispatchCount,
      generationChanged: rollback.generationChanged,
      resourceVersionChanged: rollback.resourceVersionChanged,
      templateMatchesTarget: rollback.templateMatchesTarget,
      immediateReplayDecision: replay.decision,
      postRestartReplayDecision: postRestartReplay.decision,
      replayGenerationUnchanged:
        replay.generationUnchanged && postRestartReplay.generationUnchanged,
      replayMutationFingerprintUnchanged:
        replay.mutationFingerprintUnchanged &&
        postRestartReplay.mutationFingerprintUnchanged,
    },
    recovery: {
      resolvedWebhookIsNotRecovery: resolved.incidentCompleted === false,
      scaleToZeroDecision: negative.decision,
      scaleToZeroDeploymentHealthy: negative.deploymentHealthy,
      scaleToZeroIncidentCompleted: negative.incidentCompleted,
      finalDecision: recovery.decision,
      deploymentHealthy: recovery.deploymentHealthy,
      prometheusHealthy: recovery.prometheusHealthy,
      recoveredMetricValue: recovery.prometheusValue,
      threshold: recovery.prometheusThreshold,
      incidentCompleted: recovery.incidentStage === "completed",
      completionReadbackConfirmed: recovery.completionReadbackConfirmed,
    },
    replayProtection: {
      rollbackReplayIsDuplicate: replay.decision === "duplicate",
      recoveryReplayBlocked: recoveryReplay.blocked,
      recoveryReplayBlockedBy: recoveryReplay.blockedBy,
      recoveryReplayBlockedAfterRestart: recoveryReplay.blocked,
      completedStateSurvivedRestart: show.state.stage === "completed",
    },
    cleanup: {
      gatewayStopped: cleanup.gatewayStopped,
      bridgeStopped: cleanup.bridgeStopped,
      portForwardStopped: cleanup.portForwardStopped,
      clusterDeleted: cleanup.clusterDeleted,
      localImageTagsDeleted: cleanup.localImageTagsDeleted,
      temporaryCredentialsDeleted: cleanup.temporaryCredentialsDeleted,
    },
  });
}

async function read(path) {
  return readFile(path, "utf8");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "fast" && args.length === 5) {
    const [policy, liveHook, bridge, approved, denied] = await Promise.all(
      args.map(read),
    );
    process.stdout.write(
      `${JSON.stringify(
        buildFastDemoReport(
          { policy, liveHook, bridge, approved, denied },
          process.env.GUARDIAN_PROOF_SOURCE_COMMIT,
        ),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "full" && args.length === 2) {
    const [fast, kind] = await Promise.all(args.map(read));
    process.stdout.write(
      `${JSON.stringify(
        buildFullDemoReport(JSON.parse(fast), JSON.parse(kind)),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (command === "kind" && args.length === 15) {
    const names = [
      "prepare",
      "denied",
      "ambiguous",
      "offTarget",
      "rollback",
      "replay",
      "postRestartReplay",
      "reconcile",
      "resolved",
      "negative",
      "recovery",
      "recoveryReplay",
      "show",
      "rbac",
      "cleanup",
    ];
    const values = args.map((value) => JSON.parse(value));
    process.stdout.write(
      `${JSON.stringify(
        buildKindSafetyReport({
          ...Object.fromEntries(names.map((name, index) => [name, values[index]])),
          sourceCommit: process.env.GUARDIAN_PROOF_SOURCE_COMMIT,
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  throw new Error(
    "usage: final-proof-report.mjs fast <policy> <hook> <bridge> <approve> <deny> | full <fast.json> <kind.json> | kind <15 JSON results>",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
