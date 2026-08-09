# Vulcan

> **Vulcan is a temporary codename.** The final product name, logo, and brand system are not chosen
> yet. Every identifier in this repository — package scope, bundle id, home directory, CLI name — is
> expected to change once a name is supplied.

Vulcan is a **software factory control plane**: a local-first desktop app where the unit of work is a
declarative, executable, observable workflow rather than a chat transcript.

It keeps the polished native agent experience and multi-provider support of its upstream (see
[Origins](#origins)) and adds a Software Factory kernel that owns Workflow Definitions, execution
scheduling, target leases, retries, budgets, evidence-bearing gates, approvals, and completion.

## What it does

- **Run the AI accounts you already pay for.** Claude Code, Codex, Antigravity, OpenCode, Cursor,
  Grok, Kilo Code, Droid, and Pi — through one provider-neutral capability contract. Capabilities
  that cannot be confirmed are reported as _unavailable_, never inferred and never rendered as zero.
- **Compose a Workspace from up to nine Panes** in a persistent, resizable, drag-and-drop 3x3 grid.
  Each Pane has a mode: Vulcan Agent (the native agent surface) or Herdr Terminal today; Browser,
  Diff, Factory, Trace, and Lavish Review over time. Moving, resizing, switching mode, or closing a
  Pane never terminates the session behind it.
- **Execute Workflow Definitions,** not prose instructions. Agent judgment nodes are distinct from
  deterministic command, test, git, browser, review, approval, and deploy nodes. Nodes exchange typed
  envelopes and immutable Artifacts.
- **Prove completion.** Gate Results cite exact evidence and git revisions. A new revision invalidates
  stale verification evidence. `Done` is derived from the configured delivery gate — moving a Kanban
  card cannot fabricate it.
- **Stop babysitting idle agents.** A supervisor runs a bounded recovery ladder (same-session resume,
  attempt retry, compatible-target reassignment, checkpointed handoff) before producing one actionable
  Attention Item.
- **Program from a laptop, execute on an always-on machine.** The controller is authoritative; the
  desktop app, paired mobile web client, and enrolled execution workers are authenticated clients.

## Status

Early and incomplete. This repository is being built against
[issue #1](https://github.com/AnalystTom/Agent_panel/issues/1), which specifies the full product.
See [`docs/architecture/`](docs/architecture) for what is implemented versus specified.

## Running it

Requires [Bun](https://bun.sh) 1.3.9+ and Node 24.13.1+ (both pinned in `.mise.toml`). Works on Linux
and macOS; Windows is inherited from upstream but not a target of the current work.

```sh
bun install
bun run dev            # server + web
bun run dev:desktop    # Electron shell
```

Provider CLIs (`codex`, `claude`, `cursor-agent`, `opencode`, `droid`, `gh`) are resolved at runtime.
You only need the ones you intend to use; missing ones are reported as unavailable.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

## Origins

Vulcan began as a clean clone of [Synara](https://github.com/Emanuele-web04/synara) at revision
`ce8728c47c853a6420adca0ce0925bfed67a0d7c`, taken on 2026-08-09. Synara itself began as a clone of
[T3Code](https://github.com/pingdotgg/t3code). Vulcan is not a GitHub fork of Synara and does not
maintain an upstream remote or an automated sync relationship with it; it is developed as an
independent product with its own branding, packaging, release system, and product direction.

Vulcan is MIT licensed. The `LICENSE` file retains the copyright notices of both upstream projects as
that license requires. Full detail on what was inherited, what was removed, and what was rewritten is
recorded in [PROVENANCE.md](./PROVENANCE.md).
