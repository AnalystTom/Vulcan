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

### Reading and writing software factory traces (`apps/server/src/factoryTrace/`)

Vulcan does not run an external software factory; it monitors one. An external ADW process
(the [Super Simple Software Factory](https://github.com/disler/super-simple-software-factory),
MIT) owns sequencing, retries, and acceptance, and writes its trace to SQLite
beside the checkout while it works. Vulcan reads that trace and draws it. Native Vulcan agent
sessions also append the same SSSF rows, so the Factory pane and external SSSF tooling see one
interoperable history across all providers.

The whole transport is their contract, followed exactly: **agents write to
SQLite, readers poll SQLite**. There is no ingest endpoint, no push channel, and
no replay path — live and history are the same `rowid > ?` query at different
cadence, so a poll asks only for what it has not seen. Read connections remain read-only. The native
writer subscribes once to the provider-neutral runtime event stream, queues work through a bounded
drainable worker, and applies `busy_timeout` so SQLite contention never enters turn processing.

`FactoryTraceSource` remains the read seam. `FactoryTraceWriter` is the independent lifecycle seam
that turns a thread into a session, turns into agent phases, and completed tool items into events.
The SQLite reader is one implementation, and the pane never learns what a `sssf.db` is, so a
different factory — or a remote one — is a new layer and nothing else. The
database is located from the thread's workspace through the same
`resolveThreadWorkspaceCwd` helper terminals and checkpoints use, or from
`VULCAN_FACTORY_TRACE_DB` when the trace lives elsewhere.

Being handed someone else's file is the normal case, and the reader is built for
it: columns their tracer added by migration are probed and substituted with NULL
rather than selected blindly, a payload that does not parse costs its own detail
and never the read, and an absent database is reported as _absent_ rather than as
an error — most repos have no factory stamped into them.

The writer creates the upstream seven-table schema and enables WAL only when the file is absent.
For existing databases it probes columns and omits unavailable optional fields without migrating the
file. Process-local ownership fencing allows status and usage updates only for session rows Vulcan
inserted itself; external rows are append-only from Vulcan's perspective.

### Trace projection (`packages/shared/src/factoryTraceTimeline.ts`)

A phase's `kind` plus `owner` **is** the lane, which is what keeps the engineer,
each deterministic code step, and each agent visually separate. Nothing is
stored: durations, positions, and lane membership are derived from the trace's
own timestamps on every render, so the picture cannot disagree with the rows it
came from. Layout never invents time — the only cosmetic liberty is a minimum
block width, and it is confined to the lane it happens in so two lanes at the
same x stay comparable.

### Factory pane (`apps/web/src/components/workspace/FactoryTracePane.tsx`)

One swim lane per worker on a shared time axis: each phase a block, each tool
call a mark inside it, each agent lane carrying the model it ran on and how full
its context window got. Clicking a phase shows its evidence — the envelope it
produced, and each gate with the `{item, ok, note}` checks behind its verdict, so
a green gate says _what_ it verified. A gate whose trace predates recorded checks
says so rather than rendering as though it checked nothing.

## Specified, not yet implemented

| Area                                             | Status                                                                                                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pane modes: Browser, Diff, Trace, Lavish Review  | Declared in the registry so layout, persistence, and automation share one taxonomy. They render an explicit "not available yet" surface and are kept out of the mode picker. |
| Work Item registry and RPC surface               | Not implemented after the factory-kernel pivot; there is no persistence, intake, RPC surface, or board UI.                                                                   |
| Factory activity board and run controls          | Not implemented. The current Factory pane is a read/write SSSF trace monitor, not a workflow runner.                                                                         |
| Real browser and Lavish workflow executors       | Not implemented as factory workflow nodes. Existing app integrations are separate from a factory execution graph.                                                            |
| Execution target enrolment and leases            | Not implemented; there is no factory target registry, remote-worker heartbeat, enrolment flow, or lease coordinator.                                                         |
| Excalidraw workflow editor                       | Not implemented; no canonical factory-workflow YAML model remains after the pivot.                                                                                           |
| Linear, Hermes, mobile intake                    | Not implemented as factory Work Item sources.                                                                                                                                |
| Tapes, Skill Proposals, optimization experiments | Not started.                                                                                                                                                                 |
| Packaged-app factory execution verification      | Not implemented because Vulcan no longer contains the proposed factory execution kernel; trace reader/writer behavior is covered at its SQLite service seams.                |

## Conventions worth knowing

- `packages/contracts` is schema-only. Runtime logic lives in `packages/shared`, which uses explicit
  subpath exports rather than a barrel.
- Migrations are append-only. Ids and names of released migrations never change; `bun run
migrations:check` enforces it.
- `bun run brand:check` fails the build if a retired upstream identity reappears outside the
  attribution allow list. See [PROVENANCE.md](../../PROVENANCE.md).
- Never `bun test`; always `bun run test`.
