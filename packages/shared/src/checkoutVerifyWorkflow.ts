// FILE: checkoutVerifyWorkflow.ts
// Purpose: A workflow the product can execute today, end to end, with no
// integrations wired.
// Layer: shared domain logic
//
// The tracer bullet is the product's goal, but most of its nodes declare
// capabilities -- `agent`, `browser`, `lavish` -- that the server does not yet
// report, so routing correctly refuses them. This workflow uses only the
// capabilities the local target genuinely has, which makes it the one an operator
// can run right now and watch produce real evidence against a real revision.
//
// It is deliberately not a toy: the gate names the artifact kind it requires, so
// it fails if the command produced nothing, and it passes only against the
// revision the commands actually ran on.

export const CHECKOUT_VERIFY_WORKFLOW_YAML = `
id: vulcan.checkout-verify
version: 1
name: Verify checkout
description: >-
  Runs a project's own checks against the current revision and gates on their
  evidence. Uses only capabilities this machine reports, so it executes without
  any provider, browser, or review integration.

policy:
  version: 1
  maxAttemptsPerNode: 2
  maxRepairLoops: 0
  attemptTimeoutSeconds: 900
  heartbeatTimeoutSeconds: 300
  requireLavishReviewForUiChanges: false

nodes:
  - id: status
    kind: command
    title: Record the working tree state
    dependsOn: []
    requiredCapabilities: [git, shell]
    workingDirectory: null
    command: git status --porcelain=v1

  - id: test
    kind: test
    title: Run the project's checks
    dependsOn: [status]
    requiredCapabilities: [shell, node]
    command: bun run test

  # Names the artifact kind it needs, so a skipped or crashed command cannot pass
  # the gate by producing nothing.
  - id: verified
    kind: gate
    title: Checks passed
    dependsOn: [test]
    requiredCapabilities: []
    checks:
      - name: Project checks passed
        requiresArtifactKinds: [test-results]
      - name: Working tree state recorded
        requiresArtifactKinds: [command-output]
`.trimStart();
