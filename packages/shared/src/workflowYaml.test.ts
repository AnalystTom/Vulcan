import { DEFAULT_FACTORY_POLICY, type WorkflowNodeId } from "@vulcan/contracts";
import { describe, expect, it } from "vitest";

import { findReadyNodes, topologicalOrder, validateDefinition } from "./factoryKernel";
import { TRACER_BULLET_WORKFLOW_YAML } from "./tracerBulletWorkflow";
import { parseWorkflowYaml, stringifyWorkflowDefinition } from "./workflowYaml";

const parseOrThrow = (source: string) => {
  const result = parseWorkflowYaml(source);
  if (!result.ok) {
    throw new Error(`expected a valid workflow, got: ${JSON.stringify(result.problems)}`);
  }
  return result.definition;
};

const problemsOf = (source: string) => {
  const result = parseWorkflowYaml(source);
  if (result.ok) throw new Error("expected problems");
  return result.problems;
};

const MINIMAL = `
id: minimal
version: 1
name: Minimal
nodes:
  - id: build
    kind: agent
    title: Build
    role: build
    promptTemplate: do it
`;

describe("workflow YAML", () => {
  it("parses a minimal workflow and defaults its policy", () => {
    const definition = parseOrThrow(MINIMAL);
    expect(definition.id).toBe("minimal");
    expect(definition.nodes).toHaveLength(1);
    expect(definition.policy).toEqual(DEFAULT_FACTORY_POLICY);
    // The author's text is kept verbatim rather than round-tripped.
    expect(definition.source).toBe(MINIMAL);
  });

  it("round-trips through canonical YAML without changing the graph", () => {
    const definition = parseOrThrow(TRACER_BULLET_WORKFLOW_YAML);
    const reparsed = parseOrThrow(stringifyWorkflowDefinition(definition));
    expect(reparsed.nodes).toEqual(definition.nodes);
    expect(reparsed.policy).toEqual(definition.policy);
  });

  it("reports the path of each problem rather than only the first", () => {
    const problems = problemsOf(`
id: broken
version: 1
name: Broken
nodes:
  - id: a
    kind: nonsense
    title: A
  - id: b
    kind: agent
    title: B
    role: wrong
    promptTemplate: x
`);
    const paths = problems.map((problem) => problem.path);
    expect(paths).toContain("nodes[0].kind");
    expect(paths).toContain("nodes[1].role");
  });

  it("names the valid capabilities when one is unknown", () => {
    // An unknown capability would otherwise route to no target and look like a
    // scheduling bug rather than a typo.
    const problems = problemsOf(`
id: caps
version: 1
name: Caps
nodes:
  - id: a
    kind: test
    title: A
    command: bun run test
    requiredCapabilities: [shel]
`);
    expect(problems[0]?.message).toContain("Unknown capability");
    expect(problems[0]?.message).toContain("shell");
  });

  it("refuses a graph with a cycle, with the cycle named", () => {
    const problems = problemsOf(`
id: cyclic
version: 1
name: Cyclic
nodes:
  - id: a
    kind: agent
    title: A
    role: build
    promptTemplate: x
    dependsOn: [b]
  - id: b
    kind: agent
    title: B
    role: build
    promptTemplate: x
    dependsOn: [a]
`);
    expect(problems.some((problem) => problem.message.includes("cycle"))).toBe(true);
  });

  it("returns a problem instead of throwing on malformed YAML", () => {
    const result = parseWorkflowYaml("id: [unclosed");
    expect(result.ok).toBe(false);
  });
});

describe("tracer bullet workflow", () => {
  const definition = parseOrThrow(TRACER_BULLET_WORKFLOW_YAML);

  it("is valid and covers every seam the issue names", () => {
    expect(validateDefinition(definition)).toEqual([]);
    const kinds = definition.nodes.map((node) => node.kind);
    expect(kinds).toEqual([
      "agent",
      "agent",
      "test",
      "browserVerification",
      "review",
      "lavishReview",
      "gate",
    ]);
  });

  it("orders as Work Item -> plan -> build -> test -> verify -> review -> PR-ready", () => {
    const order = topologicalOrder(definition)?.map((node) => node.id);
    expect(order?.[0]).toBe("plan");
    expect(order?.[1]).toBe("build");
    expect(order?.[2]).toBe("test");
    expect(order?.at(-1)).toBe("pr-ready");
  });

  it("starts with exactly the plan node ready and nothing else", () => {
    const ready = findReadyNodes(
      {
        definition,
        attempts: [],
        artifacts: [],
        gateResults: [],
        currentRevision: "rev-1" as never,
      },
      definition.policy,
    );
    expect(ready.map((entry) => entry.node.id)).toEqual(["plan"]);
  });

  it("makes the independent review structurally independent of the build", () => {
    const review = definition.nodes.find((node) => node.id === ("review" as WorkflowNodeId));
    expect(review?.kind).toBe("review");
    if (review?.kind !== "review") return;
    expect(review.independentOf).toEqual(["build"]);
  });

  it("requires the PR-ready gate to cite every kind of evidence the run produced", () => {
    const gate = definition.nodes.find((node) => node.id === ("pr-ready" as WorkflowNodeId));
    expect(gate?.kind).toBe("gate");
    if (gate?.kind !== "gate") return;
    const required = gate.checks.flatMap((check) => check.requiresArtifactKinds);
    // A gate that did not name these could pass without them ever existing.
    expect(required).toEqual([
      "test-results",
      "browser-journey",
      "screenshot",
      "review",
      "lavish-review",
    ]);
  });
});
