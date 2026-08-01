import {
  reduceAlertDelivery,
  type AlertDelivery,
  type AlertDeliveryResult,
} from "./incident-reducer.js";
import {
  MAX_REMEDIATION_ATTEMPTS,
  type IncidentState,
  type RemediationAttempt,
  type RemediationTarget,
} from "./incident-state.js";

export const RESTART_RECONCILIATION_EVIDENCE_SOURCE =
  "guardian_restart_reconciliation";

export type ExternalReconciliationOutcome =
  | {
      outcome: "confirmed_succeeded";
      summary: string;
    }
  | {
      outcome: "confirmed_failed";
      summary: string;
    }
  | {
      outcome: "unknown";
      summary: string;
    };

export type ExternalReconciliationRequest = {
  idempotencyKey: string;
  target: RemediationTarget;
  startedAt: string;
};

export interface ExternalRemediationReconciler {
  reconcile(
    request: ExternalReconciliationRequest,
  ): Promise<ExternalReconciliationOutcome>;
}

export type DeferredDeliveryRecovery =
  | { disposition: "none" }
  | {
      disposition: "held";
      delivery: AlertDelivery;
    }
  | {
      disposition: "replayed";
      delivery: AlertDelivery;
      result: AlertDeliveryResult;
    };

export type RestartReconciliationResult =
  | {
      decision: "no_running_attempt";
      externalOutcome: null;
      state: IncidentState;
      deferredDelivery: DeferredDeliveryRecovery;
    }
  | {
      decision: "settled";
      externalOutcome: "confirmed_succeeded" | "confirmed_failed";
      state: IncidentState;
      deferredDelivery: DeferredDeliveryRecovery;
    }
  | {
      decision: "manual_review";
      externalOutcome: "unknown";
      state: IncidentState;
      deferredDelivery: DeferredDeliveryRecovery;
    };

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isValidReconciliationTime(
  state: IncidentState,
  reconciledAt: string,
): boolean {
  const parsed = Date.parse(reconciledAt);
  return (
    Number.isFinite(parsed) &&
    parsed >= Date.parse(state.updatedAt) &&
    parsed >= Date.parse(state.startsAt)
  );
}

function normalizeExternalOutcome(
  value: ExternalReconciliationOutcome,
): ExternalReconciliationOutcome {
  if (
    value !== null &&
    typeof value === "object" &&
    new Set(["confirmed_succeeded", "confirmed_failed", "unknown"]).has(
      value.outcome,
    ) &&
    isNonEmptyString(value.summary)
  ) {
    return value;
  }
  return {
    outcome: "unknown",
    summary: "External reconciliation returned an invalid result.",
  };
}

function deliveryRecovery(
  state: IncidentState,
  deferredDelivery: AlertDelivery | undefined,
  settled: boolean,
): DeferredDeliveryRecovery {
  if (!deferredDelivery) {
    return { disposition: "none" };
  }
  if (!settled) {
    return {
      disposition: "held",
      delivery: structuredClone(deferredDelivery),
    };
  }
  const delivery = structuredClone(deferredDelivery);
  return {
    disposition: "replayed",
    delivery,
    result: reduceAlertDelivery(state, delivery),
  };
}

function appendReconciliationEvidence(
  state: IncidentState,
  reconciledAt: string,
  summary: string,
): IncidentState["evidence"] {
  return [
    ...state.evidence,
    {
      source: RESTART_RECONCILIATION_EVIDENCE_SOURCE,
      observedAt: reconciledAt,
      summary,
    },
  ];
}

function settleAttempt(
  state: IncidentState,
  runningIndex: number,
  running: RemediationAttempt,
  outcome: Extract<
    ExternalReconciliationOutcome,
    { outcome: "confirmed_succeeded" | "confirmed_failed" }
  >,
  reconciledAt: string,
): IncidentState {
  const succeeded = outcome.outcome === "confirmed_succeeded";
  const finished: RemediationAttempt = {
    ...running,
    status: succeeded ? "succeeded" : "failed",
    finishedAt: reconciledAt,
    error: succeeded ? null : outcome.summary,
  };
  const remediationAttempts = state.remediationAttempts.map((attempt, index) =>
    index === runningIndex ? finished : attempt,
  );

  return {
    ...state,
    stage: succeeded
      ? "recovery_check"
      : remediationAttempts.length >= MAX_REMEDIATION_ATTEMPTS
        ? "blocked"
        : "remediation",
    remediationAttempts,
    evidence: appendReconciliationEvidence(
      state,
      reconciledAt,
      outcome.summary,
    ),
    updatedAt: reconciledAt,
  };
}

export function isRestartReconciliationManualReview(
  state: IncidentState,
): boolean {
  const runningAttempts = state.remediationAttempts.filter(
    (attempt) => attempt.status === "running",
  );
  return (
    state.stage === "blocked" &&
    state.approvalStatus === "approved" &&
    runningAttempts.length === 1
  );
}

export async function reconcileIncidentOnRestart(input: {
  state: IncidentState;
  reconciler: ExternalRemediationReconciler;
  reconciledAt: string;
  deferredDelivery?: AlertDelivery;
}): Promise<RestartReconciliationResult> {
  if (!isValidReconciliationTime(input.state, input.reconciledAt)) {
    throw new Error(
      "reconciledAt must be valid and must not precede incident state",
    );
  }

  const runningIndex = input.state.remediationAttempts.findIndex(
    (attempt) => attempt.status === "running",
  );
  if (runningIndex === -1) {
    return {
      decision: "no_running_attempt",
      externalOutcome: null,
      state: input.state,
      deferredDelivery: deliveryRecovery(
        input.state,
        input.deferredDelivery,
        true,
      ),
    };
  }

  const running = input.state.remediationAttempts[runningIndex];
  if (!running) {
    throw new Error("running remediation attempt disappeared during recovery");
  }
  const external = normalizeExternalOutcome(
    await input.reconciler.reconcile({
      idempotencyKey: running.idempotencyKey,
      target: structuredClone(running.target),
      startedAt: running.startedAt,
    }),
  );

  if (external.outcome === "unknown") {
    const state: IncidentState = {
      ...input.state,
      stage: "blocked",
      evidence: appendReconciliationEvidence(
        input.state,
        input.reconciledAt,
        external.summary,
      ),
      updatedAt: input.reconciledAt,
    };
    return {
      decision: "manual_review",
      externalOutcome: "unknown",
      state,
      deferredDelivery: deliveryRecovery(
        state,
        input.deferredDelivery,
        false,
      ),
    };
  }

  const state = settleAttempt(
    input.state,
    runningIndex,
    running,
    external,
    input.reconciledAt,
  );
  return {
    decision: "settled",
    externalOutcome: external.outcome,
    state,
    deferredDelivery: deliveryRecovery(
      state,
      input.deferredDelivery,
      true,
    ),
  };
}
