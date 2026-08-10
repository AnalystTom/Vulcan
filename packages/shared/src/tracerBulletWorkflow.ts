// FILE: tracerBulletWorkflow.ts
// Purpose: The workflow the product must be able to execute end to end, written
// in the canonical YAML the kernel consumes.
// Layer: shared domain logic
//
// From issue #1: "Work Item -> isolated Workspace -> plan agent -> build agent ->
// deterministic tests -> Browser Verification -> independent Review -> Lavish
// Review -> PR-ready Gate Result."
//
// It lives in source rather than a fixture directory because it is the shape the
// kernel is designed around: it exercises agent nodes, deterministic nodes, a
// browser node, an independent review, a Lavish review, and a gate that has to
// cite every one of their artifacts. Keeping it here means a change that breaks
// the tracer bullet breaks a test.

export const TRACER_BULLET_WORKFLOW_YAML = `
id: vulcan.tracer-bullet
version: 1
name: Tracer bullet
description: >-
  Work Item to PR-ready, proving every seam the factory kernel owns: agent
  judgment, deterministic verification, real browser evidence, independent
  review, and a gate that cites all of it against one revision.

policy:
  version: 1
  maxAttemptsPerNode: 3
  maxRepairLoops: 3
  attemptTimeoutSeconds: 1800
  heartbeatTimeoutSeconds: 300
  requireLavishReviewForUiChanges: true

nodes:
  - id: plan
    kind: agent
    title: Plan the change
    role: plan
    dependsOn: []
    requiredCapabilities: [agent]
    promptTemplate: >-
      Read the Work Item and the repository. Produce a plan naming the files to
      change and how the change will be verified. Do not edit any files.

  - id: build
    kind: agent
    title: Build the change
    role: build
    dependsOn: [plan]
    requiredCapabilities: [agent, git, shell]
    promptTemplate: >-
      Implement the plan in the isolated worktree. Commit your work. Report the
      revision you produced.

  - id: test
    kind: test
    title: Run the test suite
    dependsOn: [build]
    requiredCapabilities: [shell, node]
    command: bun run test

  - id: browser-verification
    kind: browserVerification
    title: Verify the delivered surface
    dependsOn: [test]
    requiredCapabilities: [browser, node]
    startPath: /
    journey:
      - Open the preview as a new user who has never used the product.
      - Complete the primary action the Work Item describes.
      - Capture a screenshot of the delivered surface.

  # Independent of build so a second opinion is structurally guaranteed rather
  # than a matter of prompting.
  - id: review
    kind: review
    title: Independent review
    dependsOn: [test]
    requiredCapabilities: [agent, git]
    independentOf: [build]

  - id: lavish-review
    kind: lavishReview
    title: Lavish visual review
    dependsOn: [browser-verification]
    requiredCapabilities: [lavish]

  # Every check names the artifact kinds it reads, so the Gate Result cites exact
  # evidence and a revision change invalidates the pass rather than carrying it.
  - id: pr-ready
    kind: gate
    title: PR-ready
    dependsOn: [review, lavish-review]
    requiredCapabilities: []
    checks:
      - name: Tests passed
        requiresArtifactKinds: [test-results]
      - name: Delivered surface verified in a browser
        requiresArtifactKinds: [browser-journey, screenshot]
      - name: Independently reviewed
        requiresArtifactKinds: [review]
      - name: Visually reviewed
        requiresArtifactKinds: [lavish-review]
`.trimStart();
