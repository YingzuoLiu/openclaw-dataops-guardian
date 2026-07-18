name: dataops-guardian-proof3
steps:
  - id: prepare
    run: node scripts/proof3-step.mjs prepare

  - id: confirm
    approval: Apply the synthetic DataOps remediation?
    stdin: $prepare.json

  - id: apply
    run: node scripts/proof3-step.mjs apply
    stdin: $prepare.json
    when: $confirm.approved
