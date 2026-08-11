// Guardian's before_tool_call hook treats this as a canonical marker. After
// validating the request, it binds the pipeline and step working directory to
// the installed Guardian root; callers cannot select either path.
const LOBSTER_CWD = ".";

export function buildLobsterApprovalRunRequest(
  sessionKey: string,
  occurrenceId: string,
) {
  return {
    name: "lobster",
    args: {
      action: "run",
      pipeline: "workflows/incident-remediation.lobster",
      argsJson: JSON.stringify({
        alert_id: occurrenceId,
        metric: "kubernetes_deployment_revision",
        action: "rollback_latest_release",
      }),
      cwd: LOBSTER_CWD,
      timeoutMs: 20_000,
    },
    sessionKey,
  };
}

export function buildLobsterApprovalResumeRequest(
  sessionKey: string,
  resumeToken: string,
) {
  return {
    name: "lobster",
    args: {
      action: "resume",
      token: resumeToken,
      approve: true,
      cwd: LOBSTER_CWD,
      timeoutMs: 20_000,
    },
    sessionKey,
  };
}
