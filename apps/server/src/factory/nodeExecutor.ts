// FILE: nodeExecutor.ts
// Purpose: Run one workflow node for real -- a subprocess in the workspace, and
// the git revision it left behind.
// Layer: Server factory
//
// Only the deterministic node kinds are executed here. Agent, browser, and Lavish
// work is not faked: those nodes declare capabilities (`agent`, `browser`,
// `lavish`) that this server does not report, so the kernel's own routing refuses
// them and raises an Attention Item naming the missing capability. That is the
// product's rule applied to itself -- support that cannot be confirmed is
// unavailable, and the scheduler must not infer it.
//
// The exit code is evidence, never a verdict. It is recorded on the artifact so a
// gate can judge it; nothing here decides that a node succeeded because a process
// returned zero.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { GitRevision, WorkflowNode } from "@vulcan/contracts";
import type { NodeArtifactDraft, NodeOutcome } from "@vulcan/shared/factoryController";

const execFileAsync = promisify(execFile);

/** Output kept per artifact. Enough to diagnose, bounded so a chatty suite cannot flood storage. */
const MAX_CAPTURED_OUTPUT = 8_000;

export interface NodeExecutionContext {
  /** Absolute path the node runs in -- the Workspace's checkout or worktree. */
  readonly workspacePath: string;
  /** Ceiling for a single command, from the run's policy. */
  readonly timeoutSeconds: number;
}

/** Reads HEAD. Every artifact is stamped with this, so evidence is pinned to real code. */
export async function readHeadRevision(workspacePath: string): Promise<GitRevision | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: workspacePath,
      timeout: 15_000,
      windowsHide: true,
    });
    const revision = stdout.trim();
    return revision.length > 0 ? (revision as GitRevision) : null;
  } catch {
    return null;
  }
}

const truncate = (value: string): string =>
  value.length <= MAX_CAPTURED_OUTPUT
    ? value
    : `${value.slice(0, MAX_CAPTURED_OUTPUT)}\n… output truncated`;

/**
 * Runs a node and reports what happened.
 *
 * Returns a `NodeOutcome` rather than throwing, because a failing command is an
 * ordinary result the kernel has to reason about -- not an exception the
 * controller should be handling.
 */
export async function executeFactoryNode(
  node: WorkflowNode,
  context: NodeExecutionContext,
): Promise<NodeOutcome> {
  switch (node.kind) {
    case "command":
      return runShell(node.command, node.kind, context, node.workingDirectory);
    case "test":
      return runShell(node.command, node.kind, context, null);
    case "gate": {
      // A gate produces no evidence of its own; it judges what already exists,
      // and the kernel does the judging.
      const revision = await readHeadRevision(context.workspacePath);
      return revision === null
        ? { kind: "failed", failureSummary: "The workspace is not a git repository." }
        : { kind: "produced", revision, succeeded: true, artifacts: [] };
    }
    case "approval":
      // Nothing to run. The controller turns this into an Attention Item.
      return { kind: "waiting", reason: "approval-required" };
    default:
      // Unreachable while routing refuses these kinds. Kept explicit so that
      // wiring a provider later is a deliberate change here rather than a silent
      // fall-through that starts pretending.
      return {
        kind: "failed",
        failureSummary: `${node.kind} nodes need a capability this server does not provide yet.`,
      };
  }
}

async function runShell(
  command: string,
  kind: WorkflowNode["kind"],
  context: NodeExecutionContext,
  workingDirectory: string | null,
): Promise<NodeOutcome> {
  const cwd = workingDirectory
    ? `${context.workspacePath}/${workingDirectory}`.replace(/\/+/g, "/")
    : context.workspacePath;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  let timedOut = false;

  try {
    // Through a shell because workflow commands are written as shell lines
    // ("bun run test"), not argv. The command comes from a stored Workflow
    // Definition, which is server-side data an operator authored -- never from a
    // client request.
    const result = await execFileAsync(command, {
      cwd,
      shell: true,
      timeout: context.timeoutSeconds * 1000,
      maxBuffer: 10_000_000,
      windowsHide: true,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (cause) {
    const error = cause as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      message?: string;
    };
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? error.message ?? "";
    exitCode = typeof error.code === "number" ? error.code : 1;
    timedOut = error.killed === true;
  }

  const revision = await readHeadRevision(context.workspacePath);
  if (revision === null) {
    return { kind: "failed", failureSummary: "The workspace is not a git repository." };
  }

  if (timedOut) {
    // A timeout is a failure with no usable evidence, not a failing test result:
    // the suite never finished, so it says nothing about the code.
    return {
      kind: "failed",
      failureSummary: `\`${command}\` exceeded the ${context.timeoutSeconds}s attempt timeout.`,
    };
  }

  const passed = exitCode === 0;
  const artifact: NodeArtifactDraft = {
    kind: kind === "test" ? "test-results" : "command-output",
    outcome: passed ? "passed" : "failed",
    summary: truncate(
      [
        `$ ${command}`,
        `exit ${exitCode}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  };

  return { kind: "produced", revision, succeeded: passed, artifacts: [artifact] };
}
