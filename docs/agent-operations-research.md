# Agent operations: improving Codex and Claude Code in Vulcan

Research date: 2026-08-19. This is a product and operating recommendation, not
an assertion that the proposed capabilities already exist. Every factual
provider claim is linked to its first-party documentation.

## Outcome

Make an agent run legible from dispatch to production proof, then use that
evidence to route the next run better. The target is not maximum agent activity;
it is a higher rate of independently verified, shipped changes with less human
waiting, fewer overlapping edits, and measured cost per accepted feature.

## What the providers make observable

| Concern                   | Codex                                                                                                                                                                                                                         | Claude Code                                                                                                                                                                                                 | Product implication                                                                                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Durable execution         | The App Server models work as durable threads, turns, and items; it persists thread history so a client can reconnect and render a consistent timeline. [OpenAI](https://openai.com/index/unlocking-the-codex-harness/)       | CLI sessions are continuously saved locally and can be resumed by current, named, or selected session. [Anthropic](https://code.claude.com/docs/en/sessions)                                                | Preserve provider session IDs and map them to one Vulcan run. Show resume/fork as actions on that run, rather than treating a reconnect as a new task. |
| Parallel edits            | App Server was designed to let clients host core sessions per thread and surface the event stream. [OpenAI](https://openai.com/index/unlocking-the-codex-harness/)                                                            | `claude --worktree` isolates sessions; subagents can also use `isolation: "worktree"`. [Anthropic](https://code.claude.com/docs/en/worktrees)                                                               | Make the worktree the unit of write isolation. Do not dispatch two writers into the same checkout.                                                     |
| Verification controls     | Codex can export OpenTelemetry logs for prompts, approvals, tool results, MCP use, and network decisions. [OpenAI](https://openai.com/index/running-codex-safely/)                                                            | Hooks can deterministically run commands at lifecycle events; `PreToolUse`, `PostToolUse`, `Stop`, and `PreCompact` can make or block defined decisions. [Anthropic](https://code.claude.com/docs/en/hooks) | Record gates as evidence-bearing events, not a free-text "done" state.                                                                                 |
| Context handoff           | A Codex thread can be created, resumed, forked, and archived. [OpenAI](https://openai.com/index/unlocking-the-codex-harness/)                                                                                                 | `/compact` summarises context, and `PostCompact` supplies the generated summary to a hook. [Anthropic](https://code.claude.com/docs/en/hooks)                                                               | Create explicit checkpoint and compaction cards; a resumer should see the active goal, changed files, open risks, and last gate result.                |
| Cost and latency evidence | The current OpenAI model guide recommends selecting reasoning effort intentionally and comparing a baseline with one lower level on representative work. [OpenAI](https://developers.openai.com/api/docs/guides/latest-model) | Claude Code OTEL includes API retry exhaustion, compaction duration/token counts, subagent completion, and hook duration. [Anthropic](https://code.claude.com/docs/en/monitoring-usage)                     | Treat cost/capacity routing as an experiment measured from run traces, not static lore about a model.                                                  |

Two additional guardrails should be first-class data, not hidden runtime detail:

- Codex App Server can reroute a model when fallback is enabled, and reports a
  `model/rerouted` notification. Store both the requested and resolved model,
  plus the reroute reason, before attributing outcome or cost. [Codex App
  Server reference](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- Claude custom subagents can specify a model, but the actual choice has a
  documented precedence chain. Record the resolved model rather than assuming
  the frontmatter request was used. [Anthropic](https://code.claude.com/docs/en/sub-agents)

## Recommended operating loop

### 1. Dispatch a bounded outcome, not a vague request

Every run should carry: intended user outcome, exact checkout/worktree, write
scope, non-negotiable constraints, required evidence, and a stop condition.
For UI work, require the production-equivalent local route and a fresh-user
browser proof before a run is eligible to ship. That closes the gap between
"tests passed" and "the user journey works."

Use a cheap, read-only scout only for bounded exploration, file mapping, and
test discovery. Escalate to the strongest coding model for cross-cutting
design, risky changes, user-facing UX, or recovery after a failed gate. This
is a routing policy to benchmark, not a claim that a particular local model is
always cheaper or better.

### 2. Allocate writers through a worktree lease

Introduce a small queue in Vulcan with these states:

`queued -> scoped -> leased-worktree -> implementing -> verifying -> reviewable -> shipped | rejected | rolled-back`

Only one writable run may hold a checkout or worktree lease. Independent work
gets separate worktrees; review, research, and trace analysis are explicitly
read-only and may run concurrently. Claude Code's own worktree support exists
to prevent edit collisions, while its documentation also cautions that every
worktree needs its development environment initialised. [Anthropic](https://code.claude.com/docs/en/worktrees)

For Agent_panel specifically, include the local-dev isolation parameters in the
lease metadata (home directory, server and web ports, and auth posture), then
show a conflict instead of silently sharing another live Vulcan instance.

### 3. Make completion a gate pipeline

Suggested gates, with a recorded command/result/artifact for each:

1. Scope gate: diff touches only declared areas, or the run is sent back for a
   revised brief.
2. Focused correctness gate: the smallest relevant test command and its output.
3. Contract gate: the project-required formatter, lint, typecheck, migration,
   or build checks, when applicable.
4. Fresh-user gate: browser proof at the relevant route and viewport, with the
   host and build identity recorded.
5. Review gate: separate reviewer (or a fresh context) checks the diff and
   evidence against the original outcome.

Do not offer **ship** until all required gates are green. A failure is useful
telemetry: label the first failed gate and whether the next action was retry,
escalation, re-scope, or rollback. Claude hooks are suitable for deterministic
enforcement; they run at defined lifecycle points rather than relying on the
model to remember a command. [Anthropic](https://code.claude.com/docs/en/hooks-guide)

### 4. Resume deliberately

At plan approval, before compaction, at a blocked approval, and after every
gate, persist a compact structured checkpoint:

```text
goal | acceptance criteria | worktree | provider session/thread ID
files changed | commands and results | current failure/decision | next action
```

Claude exposes whether a session started normally, resumed, cleared, or after
compaction, and makes the compact summary available after compaction. [Anthropic](https://code.claude.com/docs/en/hooks) Use those events to mark a
handoff boundary and re-inject only the latest checkpoint. This prevents stale
context from becoming invisible downtime. Never resume the same Claude session
in two terminals: Anthropic documents that messages then interleave into one
transcript. [Anthropic](https://code.claude.com/docs/en/sessions)

### 5. Use a single trace schema and local-first collector

Build a provider-neutral event projection in `packages/contracts` and a
runtime normaliser in `packages/shared`, preserving provider-native payloads
as linked raw evidence. Minimum dimensions:

`run_id, provider, session_id, model, worktree, phase, event_time, duration,
tool, approval, gate, attempt, input_tokens, output_tokens, cache_tokens,
estimated_cost, error_class, retry_count, compaction, ship_outcome`.

Codex's documented OTEL surface includes user prompts, approvals, tool results,
MCP usage, and network allow/deny results. [OpenAI](https://openai.com/index/running-codex-safely/) Claude's OTEL documentation includes event ordering,
tool decisions, hook timing, compaction, retries, and subagent rollups.
[Anthropic](https://code.claude.com/docs/en/monitoring-usage) Export to a
local collector first; prompt/tool-output capture is sensitive, so make raw
content opt-in, redacted by default, and separately retained from aggregate
metrics.

## Views that make behaviour actionable

| View                     | Question it answers                                                                            | Required aggregation                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Delivery funnel          | Where do features fail: scope, tests, UI proof, review, or production?                         | Runs and first failed gate by provider/model/task class.                                            |
| Waiting timeline         | Is downtime human approval, queueing, retries, compaction, hook execution, or model/tool work? | Wall-clock phase durations and pause reasons.                                                       |
| Quality cohort           | Which routing choice leads to accepted shipping without a rollback?                            | Task class × provider/model × reasoning level × ship/rollback outcome.                              |
| Cost-to-accepted-feature | Which choice costs less after retries and rework, not just per run?                            | Provider usage/cost plus attempts, gate failures, and outcome.                                      |
| Context health           | Are long threads degrading?                                                                    | Compaction count, tokens before/after, resume count, first failure after handoff.                   |
| Worktree/port health     | Are collisions or environment setup dominating local downtime?                                 | Lease conflicts, setup failures, stale worktrees, port ownership, time to first successful command. |

Each chart must support drill-down to a run's exact events, commands, diffs,
and gate artifacts. Display **insufficient data** for small cohorts rather
than asserting a model ranking.

## Local model utilisation without quality regressions

Run a controlled routing trial rather than turning on a local model globally:

1. Define three safe, repeatable read-only tasks from Agent_panel history:
   file-map/exploration, test-failure classification, and log/trace
   summarisation.
2. Run the same task cards through the local model and a baseline provider,
   capture latency, completion rate, human correction, and gate outcome.
3. Route only task classes whose local-model cohort meets a predeclared quality
   floor. Keep it read-only first; later admit narrow mechanical edits behind
   the exact same gates.
4. Automatically fall back when the run exceeds a latency budget, returns an
   uncertain result, or hits a first failed verification gate. Capture the
   fallback reason so local capacity is improved with evidence rather than
   anecdotes.

For OpenAI models, reasoning effort should be an explicit experiment dimension:
the official guidance recommends beginning with the current setting and testing
one lower setting on representative work, escalating only when a measured
quality gain justifies it. [OpenAI](https://developers.openai.com/api/docs/guides/latest-model)

## First implementation slice

1. Define the common run/gate schema and project existing Codex and Claude
   events into it without deleting their raw traces.
2. Build the run timeline with waiting reasons, worktree/port identity, and
   a one-click resume/checkpoint card.
3. Add required-gate configuration per task class; expose no ship action until
   its evidence is present.
4. Add the delivery-funnel and cost-to-accepted-feature views, initially with
   truthful unavailable states for unsupported providers or missing cost data.
5. Run a two-week routing trial, then promote only policies that improve the
   accepted-ship and rollback cohorts.

## Sources

- [OpenAI: Unlocking the Codex harness / App Server](https://openai.com/index/unlocking-the-codex-harness/)
- [OpenAI: Running Codex safely at OpenAI / OTEL](https://openai.com/index/running-codex-safely/)
- [OpenAI: Model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [OpenAI Codex App Server reference](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [Anthropic: Run parallel sessions with worktrees](https://code.claude.com/docs/en/worktrees)
- [Anthropic: Manage sessions](https://code.claude.com/docs/en/sessions)
- [Anthropic: Subagents](https://code.claude.com/docs/en/sub-agents)
- [Anthropic: Hooks reference](https://code.claude.com/docs/en/hooks)
- [Anthropic: Automate workflows with hooks](https://code.claude.com/docs/en/hooks-guide)
- [Anthropic: Monitoring usage](https://code.claude.com/docs/en/monitoring-usage)
