name: dataops-guardian-incident-remediation
args:
  alert_id:
    default: unknown-alert
  metric:
    default: unknown-metric
  action:
    default: no_change_continue_observation
  guardian_root:
    default: .
cwd: "${guardian_root}"
steps:
  - id: prepare
    run: node scripts/remediation-step.mjs prepare

  - id: confirm
    approval: Execute the proposed DataOps remediation?
    stdin: $prepare.json

  - id: execute
    run: node scripts/remediation-step.mjs execute
    stdin: $prepare.json
    when: $confirm.approved

  - id: recovery
    run: node scripts/remediation-step.mjs recovery
    stdin: $execute.json
    when: $confirm.approved
