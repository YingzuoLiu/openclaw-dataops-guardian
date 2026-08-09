import { describe, expect, it } from "vitest";

import {
  assertSanitizedReport,
  assertSourceCommit,
  buildFastDemoReport,
  buildFullDemoReport,
  buildKindSafetyReport,
} from "./final-proof-report.mjs";

const SOURCE_COMMIT = "8860724a28fa82ea904e0f399f4d8df1b87f4df8";

function line(value) {
  return `${JSON.stringify(value)}\n`;
}

function validKindSummary() {
  return {
    schemaVersion: 1,
    ok: true,
    proof: "kind-final-safety",
    source: { commit: SOURCE_COMMIT },
    environment: {
      kindCluster: true,
      realPrometheus: true,
      realLobster: true,
      pinnedImages: true,
    },
    ingress: {
      unauthorizedStatus: 401,
      unauthorizedStateCreated: false,
      firingDisposition: "created",
      replayDisposition: "duplicate",
      webhookMetricEvidenceCount: 0,
      evidenceThroughGatewayTools: true,
    },
    approval: {
      approvedWorkflowStatus: "ok",
      deniedWorkflowStatus: "cancelled",
      deniedIncidentStage: "blocked",
      deniedBlockedBy: "approval_gate",
      deniedMutationDispatchCount: 0,
    },
    restartReconciliation: {
      ambiguousOutcome: "unknown",
      ambiguousManualReviewBlocked: true,
      ambiguousMutationDispatchCount: 0,
      appliedOutcome: "confirmed_succeeded",
    },
    authorization: {
      offTargetBlocked: true,
      offTargetBlockedBy: "allowlist_gate",
      rbacOtherDeploymentDenied: true,
      rbacOtherNamespaceDenied: true,
      rbacSecretsDenied: true,
      rbacDeleteDenied: true,
      rbacCreateDenied: true,
    },
    mutation: {
      rollbackDecision: "rolled_back",
      dispatchCount: 1,
      generationChanged: true,
      resourceVersionChanged: true,
      templateMatchesTarget: true,
      immediateReplayDecision: "duplicate",
      postRestartReplayDecision: "duplicate",
      replayGenerationUnchanged: true,
      replayMutationFingerprintUnchanged: true,
    },
    recovery: {
      resolvedWebhookIsNotRecovery: true,
      scaleToZeroDecision: "not_recovered",
      scaleToZeroDeploymentHealthy: false,
      scaleToZeroIncidentCompleted: false,
      finalDecision: "recovered",
      deploymentHealthy: true,
      prometheusHealthy: true,
      recoveredMetricValue: 1,
      threshold: 0.95,
      incidentCompleted: true,
      completionReadbackConfirmed: true,
    },
    replayProtection: {
      rollbackReplayIsDuplicate: true,
      recoveryReplayBlocked: true,
      recoveryReplayBlockedBy: "completed_stage_gate",
      recoveryReplayBlockedAfterRestart: true,
      completedStateSurvivedRestart: true,
    },
    cleanup: {
      gatewayStopped: true,
      bridgeStopped: true,
      portForwardStopped: true,
      clusterDeleted: true,
      localImageTagsDeleted: true,
      temporaryCredentialsDeleted: true,
    },
  };
}

describe("final proof report", () => {
  it("builds an allowlisted fast summary from noisy component logs", () => {
    const report = buildFastDemoReport({
      policy: `build output\n${line({
        ok: true,
        typedHooks: [
          "after_tool_call",
          "agent_end",
          "before_agent_finalize",
          "before_agent_run",
          "before_tool_call",
        ],
        diagnostics: [],
      })}`,
      liveHook: line({
        ok: true,
        gatewayAgentRun: true,
        hookActivationObserved: true,
        finalizeRevisionObserved: true,
        singleRunAcrossAttempts: true,
        modelCalls: 2,
        expectedModelCalls: 2,
        apiCostUsd: 0,
        rawEvidence: { gatewayLog: "/tmp/must-not-propagate" },
      }),
      bridge: line({ ok: true, proof: "alertmanager-http-bridge" }),
      approved: line({
        ok: true,
        command: "resume",
        decision: "approve",
        stage: "completed",
        approvalStatus: "approved",
        workflowStatus: "ok",
      }),
      denied: line({
        ok: true,
        command: "resume",
        decision: "deny",
        stage: "blocked",
        approvalStatus: "denied",
        workflowStatus: "cancelled",
      }),
    }, SOURCE_COMMIT);

    expect(report).toEqual({
      schemaVersion: 1,
      ok: true,
      proof: "dataops-guardian-fast-demo",
      source: { commit: SOURCE_COMMIT },
      components: {
        policyRegistration: true,
        liveAgentFinalizeGate: true,
        httpBridgeAuthCheckpointCrashRecovery: true,
        syntheticApproval: true,
        syntheticDenial: true,
      },
      apiCostUsd: 0,
    });
  });

  it("combines only sanitized fast and kind summaries", () => {
    const report = buildFullDemoReport(
      {
        schemaVersion: 1,
        ok: true,
        proof: "dataops-guardian-fast-demo",
        source: { commit: SOURCE_COMMIT },
        components: {
          policyRegistration: true,
          liveAgentFinalizeGate: true,
          httpBridgeAuthCheckpointCrashRecovery: true,
          syntheticApproval: true,
          syntheticDenial: true,
        },
      },
      { ...validKindSummary(), unexpectedInternalField: "must-not-propagate" },
    );
    expect(report).toMatchObject({
      ok: true,
      source: { commit: SOURCE_COMMIT },
      fast: { policyRegistration: true },
      live: { recovery: { incidentCompleted: true } },
    });
    expect(report.live).not.toHaveProperty("unexpectedInternalField");
  });

  it("derives the live mutation count and safety matrix from observed decisions", () => {
    const report = buildKindSafetyReport({
      prepare: {
        command: "prepare-http",
        unauthorizedStatus: 401,
        authorizedDisposition: "created",
        replayDisposition: "duplicate",
        webhookEvidenceCount: 0,
        degradedMetric: 0.7,
        classification: "critical",
        evidenceTools: [
          "guardian_query_prometheus",
          "guardian_inspect_metric_snapshot",
          "guardian_propose_remediation",
        ],
        workflowStatus: "ok",
        stage: "remediation",
        attemptStatus: "running",
      },
      denied: {
        workflowStatus: "cancelled",
        approvalStatus: "denied",
        stage: "blocked",
        rollbackBlocked: true,
        blockedBy: "approval_gate",
        mutationDispatchCount: 0,
        generationUnchanged: true,
        mutationFingerprintUnchanged: true,
      },
      ambiguous: {
        decision: "manual_review",
        externalOutcome: "unknown",
        stage: "blocked",
        mutationDispatchCount: 0,
        generationUnchanged: true,
        mutationFingerprintUnchanged: true,
      },
      offTarget: {
        blocked: true,
        blockedBy: "allowlist_gate",
        mutationDispatchCount: 0,
        generationUnchanged: true,
        mutationFingerprintUnchanged: true,
      },
      rollback: {
        decision: "rolled_back",
        patched: true,
        mutationDispatchCount: 1,
        generationChanged: true,
        resourceVersionChanged: true,
        templateMatchesTarget: true,
      },
      replay: {
        decision: "duplicate",
        patched: false,
        generationUnchanged: true,
        mutationFingerprintUnchanged: true,
      },
      postRestartReplay: {
        decision: "duplicate",
        patched: false,
        generationUnchanged: true,
        mutationFingerprintUnchanged: true,
      },
      reconcile: {
        externalOutcome: "confirmed_succeeded",
        stage: "recovery_check",
        attemptStatus: "succeeded",
        finishedAt: "2026-08-08T00:00:01.000Z",
      },
      resolved: {
        alertStatus: "resolved",
        incidentStage: "recovery_check",
        recoveryEvidencePresent: false,
        incidentCompleted: false,
      },
      negative: {
        decision: "not_recovered",
        deploymentHealthy: false,
        deploymentIssues: ["desired_replicas_not_positive"],
        incidentStage: "recovery_check",
        incidentCompleted: false,
        checkedAt: "2026-08-08T00:00:02.000Z",
      },
      recovery: {
        decision: "recovered",
        deploymentHealthy: true,
        prometheusHealthy: true,
        prometheusValue: 1,
        prometheusThreshold: 0.95,
        prometheusObservedAt: "2026-08-08T00:00:03.000Z",
        incidentStage: "completed",
        evidenceSource: "guardian_deployment_prometheus_recovery",
        completionReadbackConfirmed: true,
      },
      recoveryReplay: {
        blocked: true,
        blockedBy: "completed_stage_gate",
        incidentStage: "completed",
      },
      show: { state: { stage: "completed" } },
      rbac: {
        otherDeploymentDenied: true,
        otherNamespaceDenied: true,
        secretsDenied: true,
        deleteDenied: true,
        createDenied: true,
      },
      cleanup: {
        gatewayStopped: true,
        bridgeStopped: true,
        portForwardStopped: true,
        clusterDeleted: true,
        localImageTagsDeleted: true,
        temporaryCredentialsDeleted: true,
      },
      sourceCommit: SOURCE_COMMIT,
    });

    expect(report).toMatchObject({
      ok: true,
      ingress: { unauthorizedStatus: 401, webhookMetricEvidenceCount: 0 },
      mutation: { dispatchCount: 1 },
      recovery: {
        scaleToZeroDecision: "not_recovered",
        incidentCompleted: true,
      },
      cleanup: { clusterDeleted: true },
    });
  });

  it("refuses to publish a partially observed live safety matrix", () => {
    expect(() =>
      buildKindSafetyReport({
        prepare: { command: "prepare-http", unauthorizedStatus: 200 },
        sourceCommit: SOURCE_COMMIT,
      }),
    ).toThrow("HTTP ingress");
  });

  it("binds every released report to one exact source commit", () => {
    expect(assertSourceCommit(SOURCE_COMMIT)).toBe(SOURCE_COMMIT);
    expect(() => assertSourceCommit("8860724a")).toThrow(
      "full lowercase Git SHA",
    );

    expect(() =>
      buildFullDemoReport(
        {
          schemaVersion: 1,
          ok: true,
          proof: "dataops-guardian-fast-demo",
          source: { commit: SOURCE_COMMIT },
          components: {
            policyRegistration: true,
            liveAgentFinalizeGate: true,
            httpBridgeAuthCheckpointCrashRecovery: true,
            syntheticApproval: true,
            syntheticDenial: true,
          },
        },
        {
          ...validKindSummary(),
          source: { commit: "0000000000000000000000000000000000000000" },
        },
      ),
    ).toThrow("kind safety report is not successful");
  });

  it("rejects credentials, raw payload fields, and absolute paths", () => {
    expect(() => assertSanitizedReport({ gatewayToken: "secret" })).toThrow(
      "forbidden key",
    );
    expect(() => assertSanitizedReport({ sessionKey: "incident" })).toThrow(
      "forbidden key",
    );
    expect(() => assertSanitizedReport({ rawWebhook: {} })).toThrow(
      "forbidden key",
    );
    expect(() => assertSanitizedReport({ log: "/tmp/proof.log" })).toThrow(
      "absolute path",
    );
    expect(() =>
      assertSanitizedReport({ log: "\\\\server\\share\\proof.log" }),
    ).toThrow("absolute path");
    expect(() =>
      assertSanitizedReport({ log: "FILE:///tmp/proof.log" }),
    ).toThrow("absolute path");
    expect(() =>
      assertSanitizedReport({ value: "prefix-sensitive-value" }, [
        "sensitive-value",
      ]),
    ).toThrow("forbidden value");
  });
});
