# Vulcan architecture: implemented versus specified

Vulcan is being built against [issue #1](https://github.com/AnalystTom/Agent_panel/issues/1), which
specifies the whole product. This file says what actually exists today, so nobody has to infer it
from the diff.

Anything marked **specified** has a contract, a plan, or a placeholder but does not work yet. The
product's own rule applies to its documentation: unavailable is reported as unavailable, never as
zero and never as done.

## Layout

| Package              | Role                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server`        | The authoritative controller. Effect-TS services, SQLite persistence, provider adapters, terminals, git, the WebSocket RPC surface. |
| `apps/web`           | React UI. Workspace pane grid, agent surfaces, Kanban, pull requests.                                                               |
| `apps/desktop`       | Electron shell supervising the server.                                                                                              |
| `packages/contracts` | Schema-only contracts shared by every package.                                                                                      |
| `packages/shared`    | Pure domain logic both the server and the web app apply, so a value written by one is always valid to the other.                    |

## Implemented

### Workspace pane grid (`packages/shared/src/workspaceLayout.ts`)

A Workspace renders up to nine panes in a grid bounded to three rows and three columns. The layout is
**rows of cells** rather than a binary split tree, because that encodes the bound structurally instead
of re-deriving it from nesting depth on every operation.

Panes are stored beside the grid, so identity, mode, and attachments survive a move. Attachments are
kept per mode, which makes a mode switch reversible: switching away and back resumes the same Agent
Session or terminal.

Every operation is a pure total function returning the next layout or a typed rejection. Refusals are
values because callers must branch on them — a full grid makes automation raise an Attention Item,
while a pinned pane makes it look elsewhere. `normalizeWorkspaceLayout` runs after every mutation and
on every read, so no rendered layout can have a dangling cell, a duplicated pane, an empty row, or a
region below the minimum size.

Persistence is one JSON document per Workspace (migration `090`) with the revision as an
optimistic-concurrency token. A losing write returns the winning layout so the client can rebase.

### Herdr Terminal (`apps/server/src/herdr/`)

Availability is an explicit tagged value with a typed reason — missing binary, unreadable status,
protocol too old, server not running, server incompatible — each mapping to a different remedy,
reported in the order an operator would try them.

The load-bearing property: the bridge **cannot** produce a fallback. `resolveAttachCommand` returns
null when Herdr is unavailable, and the terminal manager treats a named launch as having exactly one
acceptable command and no shell candidates. A Herdr pane fails visibly instead of silently becoming a
plain shell wearing Herdr's name. When the operator opts into the built-in terminal, the pane header
says so and the choice is recorded as a `fallbackTerminalId`, never as a session name.

### Software Factory kernel (`packages/shared/src/factoryKernel.ts`)

Pure decisions over run state, with `now` passed in, so a controller crash and replay cannot produce a
different schedule than the first pass. Four rules are structural rather than conventional:

- **Success is only reachable through verification.** `running` has no edge to `succeeded`.
  Acceptance comes from tests and gates over evidence, never from a clean exit code.
- **Absence of evidence is never a pass.** A gate check with no admissible artifact fails.
- **Waiting always says what it is waiting for.** Every waiting state carries a typed reason, enforced
  at the transition.
- **The recovery ladder is bounded and always ends at a person.** Resume, retry, reassign, handoff,
  attention — skipping reassignment for an attempt that never held a target, and short-circuiting when
  the attempt budget is spent.

Revision pinning distinguishes verification from production. A test, browser check, review, or gate is
only satisfied at the current revision; production work is satisfied by any success. Invalidating
production work would make every build invalidate itself, since committing moves the revision.

### Canonical workflow YAML (`packages/shared/src/workflowYaml.ts`)

Workflow Definitions are immutable, versioned, and parsed from typed YAML that is the canonical graph.
Parsing is strict and total: a definition or every problem with its path. A definition that does not
validate is never persisted, so the rest of the kernel can assume the stored plan is executable.

### Kanban and Factory projections (`packages/shared/src/workItemProjection.ts`)

Two views over one set of facts, neither holding state. `done` is derived from the configured delivery
gate having passed at the current revision — nothing reads a stored column, so there is no way to put
a card in done by moving it.

### Tracer bullet (`packages/shared/src/factoryController.ts`, `tracerBullet.e2e.test.ts`)

The controller drives a run against injected executors, a clock, and id factories, so the same loop
runs against real agents in production and deterministic executors in a test with no branch saying
which. The end-to-end test runs the tracer-bullet workflow against a **real temporary git
repository**: the build node makes a real commit, so revision pinning and evidence invalidation are
exercised against git rather than a fixture. It asserts the PR-ready Gate Result cites evidence at a
real 40-character SHA, that a later commit invalidates the pass, that a retry stays within budget, and
that an exhausted budget produces exactly one Attention Item.

### Running the factory (`apps/server/src/factory/`)

Migration 091 persists definitions, runs, attempts, artifacts, gate verdicts,
attention items, targets, and leases. `readRunSnapshot` rebuilds the exact value
the kernel consumes, so a controller that restarts resumes with nothing lost.

A polling controller ticks every two seconds: it reclaims expired leases, sweeps
in-flight attempts for stalls, dispatches whatever the kernel says is ready, and
derives the run's state. It holds no state between ticks, so a restart is
indistinguishable from a slow tick. This is where `detectStall` and the recovery
ladder finally take effect, with spent rungs stored on the attempt so a restart
cannot restart the ladder.

Work the server cannot do is refused by capability routing rather than faked. The
local target reports `git`, `shell`, `node` and nothing else, so a node needing
`agent`, `browser`, or `lavish` produces an Attention Item naming the missing
capability. `checkout-verify` ships as a workflow that runs today; the tracer
bullet correctly reports that it cannot.

A run's working directory is derived from its thread through the same
`resolveThreadWorkspaceCwd` helper terminals and checkpoints use, so a factory run
and an Agent Pane on the same thread cannot disagree about which checkout they are
in.

### Factory pane (`apps/web/src/components/workspace/FactoryPane.tsx`)

Renders the whole graph including nodes that have not run, an activity summary,
per-node evidence drill-down with artifact output and gate checks, and the
Attention Inbox with the recovery rungs already tried. The view is derived on the
client by the same shared projections the kernel's tests cover, so it cannot show
one thing while the kernel believes another. Its empty state lists the built-in
workflows and says, per workflow, whether it can run here and which capabilities
are missing if not.

## Specified, not yet implemented

| Area                                                     | Status                                                                                                                                                                        |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pane modes: Browser, Diff, Factory, Trace, Lavish Review | Declared in the registry so layout, persistence, and automation share one taxonomy. They render an explicit "not available yet" surface and are kept out of the mode picker.  |
| Work Item registry and RPC surface                       | Contract and projections exist; there is no persistence, no intake, and no board UI yet.                                                                                      |
| Factory view UI                                          | Waterfall and activity board are computed and tested; nothing renders them.                                                                                                   |
| Real agent/browser/Lavish executors                      | Not wired. Those capabilities are deliberately not reported by the local target, so routing refuses their nodes and raises an Attention Item naming what is missing.          |
| Execution target enrolment                               | The local target registers itself and routing works. There is no remote worker, heartbeat, or enrolment flow, so "execute on the always-on server" is modelled but not built. |
| Execution targets and leases                             | Modelled and routed over in the kernel. No enrolment, heartbeat, or remote worker exists.                                                                                     |
| Real agent, browser, and Lavish executors                | The tracer bullet uses deterministic stand-ins. No provider adapter, Playwright harness, or Lavish sidecar is wired to a node.                                                |
| Excalidraw workflow editor                               | The canonical YAML representation it would read and emit exists; the editor does not.                                                                                         |
| Linear, Hermes, mobile intake                            | Work Item sources are modelled. No integration exists.                                                                                                                        |
| Tapes, Skill Proposals, optimization experiments         | Not started. Explicitly downstream of the tracer bullet being trustworthy.                                                                                                    |
| Packaged-app end-to-end verification                     | The issue's primary seam runs through the packaged desktop app; the current end-to-end test runs at the kernel seam.                                                          |

## Conventions worth knowing

- `packages/contracts` is schema-only. Runtime logic lives in `packages/shared`, which uses explicit
  subpath exports rather than a barrel.
- Migrations are append-only. Ids and names of released migrations never change; `bun run
migrations:check` enforces it.
- `bun run brand:check` fails the build if a retired upstream identity reappears outside the
  attribution allow list. See [PROVENANCE.md](../../PROVENANCE.md).
- Never `bun test`; always `bun run test`.
