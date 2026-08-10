// FILE: workflowYaml.ts
// Purpose: Parse and serialize the canonical typed YAML representation of a
// Workflow Definition.
// Layer: shared domain logic
//
// YAML is the canonical graph. Everything else -- the Factory view, and the
// Excalidraw editor when it lands -- reads and emits changes through this module
// rather than maintaining a second authoritative graph, so a visual edit can
// never produce a hidden state that is not executable.
//
// Parsing is deliberately strict and total: it returns a definition or a list of
// problems, and never throws or half-builds. A definition that does not parse is
// never persisted, which is what lets the rest of the kernel assume the stored
// plan is executable.

import {
  DEFAULT_FACTORY_POLICY,
  type FactoryPolicy,
  type TargetCapability,
  type WorkflowDefinition,
  type WorkflowDefinitionId,
  type WorkflowNode,
  type WorkflowNodeId,
} from "@vulcan/contracts";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { validateDefinition, type DefinitionProblem } from "./factoryKernel";

export interface WorkflowYamlProblem {
  /** Dotted path to the offending value, e.g. `nodes[2].command`. */
  readonly path: string;
  readonly message: string;
}

export type WorkflowYamlResult =
  | { readonly ok: true; readonly definition: WorkflowDefinition }
  | { readonly ok: false; readonly problems: readonly WorkflowYamlProblem[] };

const VALID_CAPABILITIES: readonly TargetCapability[] = [
  "agent",
  "git",
  "shell",
  "node",
  "browser",
  "computer-use",
  "docker",
  "lavish",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Reads a workflow from YAML.
 *
 * The graph is validated structurally here and semantically by
 * `validateDefinition`, and both sets of problems are returned together so one
 * edit-and-retry cycle surfaces everything wrong rather than one thing at a time.
 */
export function parseWorkflowYaml(source: string): WorkflowYamlResult {
  const problems: WorkflowYamlProblem[] = [];

  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (cause) {
    return {
      ok: false,
      problems: [{ path: "", message: cause instanceof Error ? cause.message : "Invalid YAML." }],
    };
  }

  if (!isRecord(document)) {
    return { ok: false, problems: [{ path: "", message: "Expected a YAML mapping." }] };
  }

  const id = readString(document.id, "id", problems);
  const name = readString(document.name, "name", problems);
  const version = readPositiveInt(document.version, "version", problems);
  const description = typeof document.description === "string" ? document.description : "";

  const policy = readPolicy(document.policy, problems);

  const rawNodes = document.nodes;
  const nodes: WorkflowNode[] = [];
  if (!Array.isArray(rawNodes)) {
    problems.push({ path: "nodes", message: "Expected a list of nodes." });
  } else {
    for (const [index, rawNode] of rawNodes.entries()) {
      const node = readNode(rawNode, `nodes[${index}]`, problems);
      if (node) nodes.push(node);
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  const definition: WorkflowDefinition = {
    id: id as WorkflowDefinitionId,
    version,
    name,
    description,
    nodes,
    policy,
    // The source is kept verbatim so an audit reads what the author wrote, not a
    // round-tripped reformatting of it.
    source,
  };

  const semantic = validateDefinition(definition);
  if (semantic.length > 0) {
    return { ok: false, problems: semantic.map(describeDefinitionProblem) };
  }

  return { ok: true, definition };
}

/** Renders a definition back to canonical YAML, for the visual editor's writes. */
export function stringifyWorkflowDefinition(definition: WorkflowDefinition): string {
  return stringifyYaml(
    {
      id: definition.id,
      version: definition.version,
      name: definition.name,
      ...(definition.description ? { description: definition.description } : {}),
      policy: definition.policy,
      nodes: definition.nodes,
    },
    { lineWidth: 100 },
  );
}

function describeDefinitionProblem(problem: DefinitionProblem): WorkflowYamlProblem {
  switch (problem.kind) {
    case "duplicate-node":
      return { path: `nodes.${problem.nodeId}`, message: "Two nodes share this id." };
    case "unknown-dependency":
      return {
        path: `nodes.${problem.nodeId}.dependsOn`,
        message: `Depends on "${problem.dependsOn}", which is not a node in this workflow.`,
      };
    case "self-dependency":
      return {
        path: `nodes.${problem.nodeId}.dependsOn`,
        message: "A node cannot depend on itself.",
      };
    case "cycle":
      return {
        path: "nodes",
        message: `These nodes depend on each other in a cycle: ${problem.nodeIds.join(" -> ")}.`,
      };
    case "review-not-independent":
      return {
        path: `nodes.${problem.nodeId}.independentOf`,
        message: "An independent review must name the nodes it is independent of.",
      };
    case "gate-without-checks":
      return {
        path: `nodes.${problem.nodeId}.checks`,
        message: "A gate needs at least one check.",
      };
  }
}

function readString(value: unknown, path: string, problems: WorkflowYamlProblem[]): string {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  problems.push({ path, message: "Expected a non-empty string." });
  return "";
}

function readPositiveInt(value: unknown, path: string, problems: WorkflowYamlProblem[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= 1) return value;
  problems.push({ path, message: "Expected a whole number of 1 or more." });
  return 1;
}

function readStringList(value: unknown, path: string, problems: WorkflowYamlProblem[]): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push({ path, message: "Expected a list of strings." });
    return [];
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string" && entry.trim().length > 0) result.push(entry.trim());
    else problems.push({ path: `${path}[${index}]`, message: "Expected a non-empty string." });
  }
  return result;
}

function readCapabilities(
  value: unknown,
  path: string,
  problems: WorkflowYamlProblem[],
): TargetCapability[] {
  const raw = readStringList(value, path, problems);
  const capabilities: TargetCapability[] = [];
  for (const entry of raw) {
    if ((VALID_CAPABILITIES as readonly string[]).includes(entry)) {
      capabilities.push(entry as TargetCapability);
      continue;
    }
    // Naming the valid set matters: an unknown capability would otherwise route
    // to no target at all and look like a scheduling bug.
    problems.push({
      path,
      message: `Unknown capability "${entry}". Valid capabilities: ${VALID_CAPABILITIES.join(", ")}.`,
    });
  }
  return capabilities;
}

function readPolicy(value: unknown, problems: WorkflowYamlProblem[]): FactoryPolicy {
  if (value === undefined || value === null) return DEFAULT_FACTORY_POLICY;
  if (!isRecord(value)) {
    problems.push({ path: "policy", message: "Expected a mapping." });
    return DEFAULT_FACTORY_POLICY;
  }
  const readNumber = (key: keyof FactoryPolicy, fallback: number): number => {
    const raw = value[key];
    if (raw === undefined) return fallback;
    if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
    problems.push({ path: `policy.${String(key)}`, message: "Expected a whole number." });
    return fallback;
  };

  const costBudgetCents =
    value.costBudgetCents === undefined || value.costBudgetCents === null
      ? null
      : readNumber("costBudgetCents", 0);

  return {
    version: readNumber("version", DEFAULT_FACTORY_POLICY.version) || 1,
    maxAttemptsPerNode: readNumber("maxAttemptsPerNode", DEFAULT_FACTORY_POLICY.maxAttemptsPerNode),
    maxRepairLoops: readNumber("maxRepairLoops", DEFAULT_FACTORY_POLICY.maxRepairLoops),
    attemptTimeoutSeconds: readNumber(
      "attemptTimeoutSeconds",
      DEFAULT_FACTORY_POLICY.attemptTimeoutSeconds,
    ),
    heartbeatTimeoutSeconds: readNumber(
      "heartbeatTimeoutSeconds",
      DEFAULT_FACTORY_POLICY.heartbeatTimeoutSeconds,
    ),
    costBudgetCents,
    requireLavishReviewForUiChanges:
      typeof value.requireLavishReviewForUiChanges === "boolean"
        ? value.requireLavishReviewForUiChanges
        : DEFAULT_FACTORY_POLICY.requireLavishReviewForUiChanges,
  };
}

function readNode(
  raw: unknown,
  path: string,
  problems: WorkflowYamlProblem[],
): WorkflowNode | null {
  if (!isRecord(raw)) {
    problems.push({ path, message: "Expected a mapping." });
    return null;
  }

  const before = problems.length;
  const id = readString(raw.id, `${path}.id`, problems) as WorkflowNodeId;
  const title = readString(raw.title, `${path}.title`, problems);
  const dependsOn = readStringList(
    raw.dependsOn,
    `${path}.dependsOn`,
    problems,
  ) as WorkflowNodeId[];
  const requiredCapabilities = readCapabilities(
    raw.requiredCapabilities,
    `${path}.requiredCapabilities`,
    problems,
  );
  const base = { id, title, dependsOn, requiredCapabilities };
  const kind = typeof raw.kind === "string" ? raw.kind : "";

  const node = ((): WorkflowNode | null => {
    switch (kind) {
      case "agent": {
        const role = typeof raw.role === "string" ? raw.role : "";
        if (!["plan", "build", "review", "repair"].includes(role)) {
          problems.push({
            path: `${path}.role`,
            message: "Expected one of: plan, build, review, repair.",
          });
          return null;
        }
        return {
          ...base,
          kind: "agent",
          role: role as "plan" | "build" | "review" | "repair",
          promptTemplate: readString(raw.promptTemplate, `${path}.promptTemplate`, problems),
        };
      }
      case "command":
        return {
          ...base,
          kind: "command",
          command: readString(raw.command, `${path}.command`, problems),
          workingDirectory: typeof raw.workingDirectory === "string" ? raw.workingDirectory : null,
        };
      case "test":
        return {
          ...base,
          kind: "test",
          command: readString(raw.command, `${path}.command`, problems),
        };
      case "browserVerification":
        return {
          ...base,
          kind: "browserVerification",
          journey: readStringList(raw.journey, `${path}.journey`, problems),
          startPath: readString(raw.startPath, `${path}.startPath`, problems),
        };
      case "review":
        return {
          ...base,
          kind: "review",
          independentOf: readStringList(
            raw.independentOf,
            `${path}.independentOf`,
            problems,
          ) as WorkflowNodeId[],
        };
      case "lavishReview":
        return { ...base, kind: "lavishReview" };
      case "approval":
        return {
          ...base,
          kind: "approval",
          question: readString(raw.question, `${path}.question`, problems),
        };
      case "gate": {
        const rawChecks = raw.checks;
        if (!Array.isArray(rawChecks)) {
          problems.push({ path: `${path}.checks`, message: "Expected a list of checks." });
          return null;
        }
        const checks = rawChecks.map((rawCheck, index) => {
          const checkPath = `${path}.checks[${index}]`;
          if (!isRecord(rawCheck)) {
            problems.push({ path: checkPath, message: "Expected a mapping." });
            return { name: "", requiresArtifactKinds: [] };
          }
          return {
            name: readString(rawCheck.name, `${checkPath}.name`, problems),
            requiresArtifactKinds: readStringList(
              rawCheck.requiresArtifactKinds,
              `${checkPath}.requiresArtifactKinds`,
              problems,
            ),
          };
        });
        return { ...base, kind: "gate", checks };
      }
      default:
        problems.push({
          path: `${path}.kind`,
          message:
            "Expected one of: agent, command, test, browserVerification, review, lavishReview, approval, gate.",
        });
        return null;
    }
  })();

  // A node that produced problems is not returned even if it was shaped enough to
  // build, so a partially-valid node can never end up in a stored definition.
  return problems.length === before ? node : null;
}
