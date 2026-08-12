import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOBSTER_TOOL_POLICY_MODE = "incident_workflow_only";
export const INCIDENT_WORKFLOW = "workflows/incident-remediation.lobster";
export const INCIDENT_WORKFLOW_PATH = fileURLToPath(
  new URL(`../../${INCIDENT_WORKFLOW}`, import.meta.url),
);

const ALLOWED_REMEDIATION_ACTIONS = new Set([
  "hold_deployments_and_increase_observation",
  "no_change_continue_observation",
  "rollback_latest_release",
]);
const WORKFLOW_STATE_KEY =
  /^workflow_resume_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_STATE_BYTES = 1024 * 1024;
const INCIDENT_APPROVAL_STEP_ID = "confirm";
const INCIDENT_RESUME_AT_INDEX = 2;

type LobsterGateDecision =
  | { block: true; blockReason: string }
  | { params: Record<string, unknown> }
  | undefined;

type LobsterGateParams = {
  rawConfig: unknown;
  toolParams: Record<string, unknown>;
  runId?: string | undefined;
  env?: NodeJS.ProcessEnv;
  expectedWorkflowPath?: string;
  homeDirectory?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function isBoundedString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isBoundedTimeout(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 20_000;
}

function validateIncidentArgs(value: unknown): value is Record<string, string> {
  if (!isRecord(value) || !hasExactKeys(value, ["action", "alert_id", "metric"])) {
    return false;
  }
  return (
    isBoundedString(value.alert_id) &&
    isBoundedString(value.metric) &&
    typeof value.action === "string" &&
    ALLOWED_REMEDIATION_ACTIONS.has(value.action)
  );
}

function hasCanonicalWorkflowCwd(value: unknown): boolean {
  return value === ".";
}

function validatedRunArgs(
  params: Record<string, unknown>,
): Record<string, string> | undefined {
  if (
    !hasExactKeys(params, ["action", "argsJson", "cwd", "pipeline", "timeoutMs"]) ||
    params.action !== "run" ||
    params.pipeline !== INCIDENT_WORKFLOW ||
    !hasCanonicalWorkflowCwd(params.cwd) ||
    !isBoundedTimeout(params.timeoutMs) ||
    typeof params.argsJson !== "string" ||
    params.argsJson.length > 4096
  ) {
    return undefined;
  }
  try {
    const args: unknown = JSON.parse(params.argsJson);
    return validateIncidentArgs(args) ? args : undefined;
  } catch {
    return undefined;
  }
}

function validatePersistedIncidentArgs(
  value: unknown,
  expectedGuardianRoot: string,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["action", "alert_id", "guardian_root", "metric"])
  ) {
    return false;
  }
  const { guardian_root: _guardianRoot, ...incidentArgs } = value;
  return (
    _guardianRoot === expectedGuardianRoot &&
    validateIncidentArgs(incidentArgs)
  );
}

function expectedPrepareResult(args: Record<string, unknown>) {
  return {
    step: "prepare",
    alertId: args.alert_id,
    metric: args.metric,
    action: args.action,
    preview: `Synthetic execution plan: ${String(args.action)} for ${String(args.alert_id)}.`,
    mutatesProduction: false,
  };
}

function validatePrepareResult(
  value: unknown,
  expected: ReturnType<typeof expectedPrepareResult>,
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      "action",
      "alertId",
      "metric",
      "mutatesProduction",
      "preview",
      "step",
    ]) &&
    value.step === expected.step &&
    value.alertId === expected.alertId &&
    value.metric === expected.metric &&
    value.action === expected.action &&
    value.preview === expected.preview &&
    value.mutatesProduction === false
  );
}

function validatePersistedStep(
  value: unknown,
  id: "prepare" | "confirm",
  expected: ReturnType<typeof expectedPrepareResult>,
): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["id", "json", "stdout"]) ||
    value.id !== id ||
    typeof value.stdout !== "string" ||
    value.stdout.length === 0 ||
    value.stdout.length > 4096 ||
    !validatePrepareResult(value.json, expected)
  ) {
    return false;
  }
  try {
    return validatePrepareResult(JSON.parse(value.stdout.trim()), expected);
  } catch {
    return false;
  }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function validatePersistedResumeState(
  state: unknown,
  expectedWorkflowPath: string,
  expectedGuardianRoot: string,
): boolean {
  if (
    !isRecord(state) ||
    !hasExactKeys(state, [
      "approvalIdentity",
      "approvalStepId",
      "args",
      "createdAt",
      "filePath",
      "resumeAtIndex",
      "steps",
    ]) ||
    state.filePath !== expectedWorkflowPath ||
    state.resumeAtIndex !== INCIDENT_RESUME_AT_INDEX ||
    state.approvalStepId !== INCIDENT_APPROVAL_STEP_ID ||
    !isRecord(state.approvalIdentity) ||
    // The current workflow intentionally declares no initiated/required
    // approver identity. Treat any identity fields as a contract change rather
    // than accepting state that the Guardian gate did not authorize. Enabling
    // Lobster identity constraints must update this validator and its workflow
    // layout test together.
    Object.keys(state.approvalIdentity).length !== 0 ||
    !isCanonicalIsoTimestamp(state.createdAt) ||
    !isRecord(state.args) ||
    !validatePersistedIncidentArgs(state.args, expectedGuardianRoot) ||
    !isRecord(state.steps) ||
    !hasExactKeys(state.steps, ["confirm", "prepare"])
  ) {
    return false;
  }
  const expected = expectedPrepareResult(state.args);
  return (
    validatePersistedStep(state.steps.prepare, "prepare", expected) &&
    validatePersistedStep(state.steps.confirm, "confirm", expected)
  );
}

function decodeResumeStateKey(token: unknown): string | undefined {
  if (typeof token !== "string" || token.length < 16 || token.length > 4096) {
    return undefined;
  }
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) {
      return undefined;
    }
    const decoded: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !isRecord(decoded) ||
      !hasExactKeys(decoded, ["kind", "protocolVersion", "stateKey", "v"]) ||
      decoded.protocolVersion !== 1 ||
      decoded.v !== 1 ||
      decoded.kind !== "workflow-file" ||
      typeof decoded.stateKey !== "string" ||
      !WORKFLOW_STATE_KEY.test(decoded.stateKey)
    ) {
      return undefined;
    }
    return decoded.stateKey;
  } catch {
    return undefined;
  }
}

async function validateResume(
  params: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
  expectedWorkflowPath: string,
  expectedGuardianRoot: string,
  homeDirectory: string,
): Promise<boolean> {
  if (
    !hasExactKeys(params, ["action", "approve", "cwd", "timeoutMs", "token"]) ||
    params.action !== "resume" ||
    typeof params.approve !== "boolean" ||
    !hasCanonicalWorkflowCwd(params.cwd) ||
    !isBoundedTimeout(params.timeoutMs)
  ) {
    return false;
  }
  const stateKey = decodeResumeStateKey(params.token);
  const stateDir =
    env.LOBSTER_STATE_DIR?.trim() || join(homeDirectory, ".lobster", "state");
  if (!stateKey || !stateDir || !isAbsolute(stateDir)) {
    return false;
  }
  const statePath = join(stateDir, `${stateKey}.json`);
  try {
    const stateStat = await stat(statePath);
    if (!stateStat.isFile() || stateStat.size <= 0 || stateStat.size > MAX_STATE_BYTES) {
      return false;
    }
    const state: unknown = JSON.parse(await readFile(statePath, "utf8"));
    return validatePersistedResumeState(
      state,
      expectedWorkflowPath,
      expectedGuardianRoot,
    );
  } catch {
    return false;
  }
}

function policyEnabled(rawConfig: unknown): boolean {
  if (!isRecord(rawConfig)) {
    return true;
  }
  return rawConfig.lobsterToolPolicyMode !== "disabled";
}

/**
 * Raw Lobster is a shell-capable workflow runtime. Block run-identified Agent
 * Tool calls and bind every non-Agent request to the immutable incident
 * workflow. Gateway authentication remains responsible for deciding which
 * loopback clients may make those requests. Resume calls additionally prove
 * that their token points at persisted state for that same workflow, so a
 * stale token from another pipeline cannot cross the gate.
 */
export async function buildLobsterToolGateDecision({
  rawConfig,
  toolParams,
  runId,
  env = process.env,
  expectedWorkflowPath = INCIDENT_WORKFLOW_PATH,
  homeDirectory = homedir(),
}: LobsterGateParams): Promise<LobsterGateDecision> {
  if (!policyEnabled(rawConfig)) {
    return undefined;
  }
  if (runId) {
    return {
      block: true,
      blockReason:
        "native Lobster calls are operator-only under the Guardian incident workflow policy",
    };
  }
  if (
    !isAbsolute(expectedWorkflowPath) ||
    expectedWorkflowPath.trim() !== expectedWorkflowPath ||
    expectedWorkflowPath.includes("|")
  ) {
    return {
      block: true,
      blockReason:
        "immutable Guardian incident workflow path is not supported",
    };
  }
  const expectedGuardianRoot = dirname(dirname(expectedWorkflowPath));
  const runArgs = validatedRunArgs(toolParams);
  if (runArgs) {
    // OpenClaw applies before_tool_call params as a shallow override merge.
    // Return only gate-owned fields so the validated action and timeoutMs from
    // the original request remain intact under the pinned host contract.
    return {
      params: {
        cwd: ".",
        pipeline: expectedWorkflowPath,
        argsJson: JSON.stringify({
          ...runArgs,
          guardian_root: expectedGuardianRoot,
        }),
      },
    };
  }
  if (
    toolParams.action === "resume" &&
    (await validateResume(
      toolParams,
      env,
      expectedWorkflowPath,
      expectedGuardianRoot,
      homeDirectory,
    ))
  ) {
    // The same shallow override merge preserves the already validated resume
    // token, approval decision, action, and timeout while fixing the cwd.
    return { params: { cwd: "." } };
  }
  return {
    block: true,
    blockReason:
      "Lobster request is not bound to the immutable Guardian incident workflow",
  };
}
