# Native Hermes Bot mode

Vulcan projects one native Hermes gateway into its Bots page. Hermes owns profiles, canonical Bot Chat sessions, tool execution, peer messages, hosted groups and cron. Vulcan authenticates the operator, stores the gateway connection in its existing secret store and renders native results. The bridge adds no scheduler or message queue.

This is the qualification surface for issue #3. Existing agents and histories remain accessible until migration inventory, backups, ownership transfer and acceptance runs pass. A settled model turn is not a verified business Goal.

## Runtime contract

Qualified source: [Hermes b7b35a84b7fbe1aa2e223a6ce726a2471300d0a4](https://github.com/NousResearch/hermes-agent/tree/b7b35a84b7fbe1aa2e223a6ce726a2471300d0a4).

- Connect to the native `hermes serve` endpoint `/api/ws`. The bridge checks protocol version 2, the persistent group driver and required native methods before reporting Connected.
- This qualification supports native loopback token authentication, including an operator-managed SSH tunnel. Remote execution is supported by colocating Vulcan with Hermes or tunneling to the remote loopback gateway. Enter its token separately from the URL. Non-loopback endpoints are rejected: gated Hermes gateways require browser-minted single-use tickets, and those are not interchangeable with loopback tokens. No insecure remote mode or internal-credential extraction is used.
- Only owner sessions can use the bridge. Credentials are never returned to the browser. Server provisioning may use `VULCAN_HERMES_WS_URL` and `VULCAN_HERMES_TOKEN`; GUI setup uses the existing server secret store.
- Keep the pinned Hermes executable first in tool subprocess PATHs. Qualification found a login shell selecting an older installed CLI and rejecting native DM flags. The isolated launcher corrects that PATH; upstream source is unchanged.
- Isolate with `HERMES_HOME`, keeping the operating system HOME unchanged. Use Hermes's official account import/shared-auth support rather than copying rotating credentials.
- For this bounded, persistent Bot team, set `dashboard.ws_orphan_reap_grace_s: 0` in the dedicated gateway configuration. The pinned default reaps detached sessions after 20 seconds, which also terminates pending native DM delivery processes when the coordinator has finished its model turn. A GUI service restart exposed that behavior. Parking canonical sessions prevents this desktop-oriented cleanup from interrupting remote Bot work; the dedicated runtime has a bounded roster, so abandoned ad-hoc session growth must be monitored before broader adoption.
- Disable `desktop.auto_continue.enabled` in the qualified runtime. A crashed turn may have unknown external effects; opening its transcript must not silently resubmit it. Reconcile destinations before explicitly continuing.
- Native profile toolsets govern execution. Legacy Vulcan capability grants do not sandbox a Hermes shell. Qualify account access and profile permissions before adopting existing jobs.

The bridge never retries a mutating RPC. Lost responses remain unconfirmed. Group sends retain one native event/thread identifier across explicit retries. Canonical-chat send failures require checking the conversation and resulting work before another send. Native logs supply replayed evidence; WebSocket notifications only refresh views.

## Qualification on 12 September 2026

The isolated runtime runs under `vulcan-hermes-parity.service` on big-machine-1 at `127.0.0.1:41493`. Existing services and dirty checkouts were preserved. Chief, Research, SEO and Prospects are visible; setup-only profiles are hidden without deleting their histories.

| Check            | Native evidence                                                                                                                             | Observed result                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Models           | Anthropic `claude-fable-5-1`; OpenAI Codex `gpt-5.6-luna`                                                                                   | Both returned native smoke replies before Fable reached its quota                                               |
| Chief → Research | Chief session `20260912_120224_9380ba`, tool row 3, process `proc_d3b7bd1574b6`; Research session `20260912_120236_25c0e5`, assistant row 6 | Native dispatch and recipient reply                                                                             |
| Research → SEO   | Research tool row 5, process `proc_1555149e2901`; SEO session `20260912_120244_cecc34`, assistant row 4                                     | Second native hop without operator message relay                                                                |
| Hosted group     | Room `vulcan-parity-group-20260912`; user sequence 1, Fable reply 2, Research reply 4, settled 7                                            | Driver continued after the initiating client disconnected                                                       |
| Vulcan GUI       | Research session `20260912_120236_25c0e5`, user row 7 and assistant row 8                                                                   | Fresh Playwright browser sent through Vulcan and read the exact native reply; another fresh browser replayed it |

Recovery checks also used real native sessions:

- Busy recipient: Research's native dispatch `proc_9eab64b7b65d` reached SEO session `20260912_122420_5499cd`; recipient user row 7 and assistant row 8 contain the consultation receipt. The prior sleeping turn ended interrupted, not completed. This is the pinned runtime's observed busy behavior, not a promise that work queues without interruption.
- Explicit interrupt: SEO session `20260912_123212_77a427`, rows 18–21, persisted the request, tool call and exit 130 interruption. No requested completion receipt was emitted.
- Active process restart: SEO session `20260912_122853_a8f670`, rows 15–17, persisted the request, tool call and SIGTERM exit -15. The supervised gateway returned healthy with no active sessions and no resubmitted user row or completion receipt.

These are runtime checks, not SEO, sales or publication receipts.

## Marketing acceptance goal

Produce an evidence-backed LaunchPost SEO patch within three site files and at most five sourced business prospects with fit and next action. Use the authoritative remote vault and public sources. No outreach, publication, scheduling, deployment, vault mutation or CRM write occurs during comparison.

Both isolated comparison worktrees start at LaunchPost commit `96519988568511880617cf9d840c1b5480df612f`:

- `/home/russki/.local/share/vulcan-hermes-parity/launchpost-direct`
- `/home/russki/.local/share/vulcan-hermes-parity/launchpost-gui`

Fable coordinated implementation and reviewed the acceptance path. The first marketing Chief turn, session `20260912_120726_c779fb`, encountered provider quota backoff before any worker dispatch. It was closed to prevent retries racing a later trial. The failed Chief turn is not counted as business delivery. Following Fable coordination, the authorized Luna high execution lead continued the goal through native peer messaging.

The acceptance report must join the original request, each native handoff and recipient reply, the reviewed SEO commit/PR and each prospect's public source. Comparable runs and recovery checks must pass before migration or closure of issue #3. Existing routines, Linear updates and the other original jobs retain their own acceptance gates.

### Direct native run

Research's canonical session `20260912_120236_25c0e5` contains the original execution request at row 70 and native worker dispatches at rows 89–90: SEO `proc_fcb3a39e7879` and Prospects `proc_3bb0910b0da6`. Native completion messages arrived at rows 98 and 102. Prospects also sent a native DM at row 100; its tool-backed delivery identifier is `96b4e2e82edeeb8df8d6375dfedba5d9ed22c9d7d9b5032854853768462f0f3a`. Narrative process IDs in assistant prose are not substituted for these persisted tool receipts.

Research delivered at row 136: an Organization JSON-LD logo correction from the absent `/app-logo-96.webp` to the existing `/app-logo.png`, a focused regression check, and five publicly sourced prospect candidates. The candidates are fit hypotheses, not observed purchase intent. Focused tests, typecheck, lint (seven existing warnings), build and diff validation passed in the isolated direct worktree. The logo also matches the existing application's brand component and is a 1024×1024 PNG.

This run required operator intervention: an initial temporary Research session was not canonical; one template-derived prospect was excluded after source review; and an attempted reset to a moving main branch was denied through Vulcan. The continuation at row 104 preserved the frozen baseline and completed ordinary edits. These interventions are part of the evidence, so this is a qualitative runtime comparison rather than a controlled speed benchmark.

The external Linear connector returned `oauth_token_invalid_grant`; no issue was created or marked Done. No ranking improvement, acquired lead, deployed change or external outreach is claimed by a review-ready patch and prospect artifact.

### Through-Vulcan run

A fresh Playwright browser submitted the frozen goal through Vulcan at 12:10:37 UTC. Research session `20260912_131037_e4b321` persisted the original request at row 1 and dispatched SEO `proc_4d04f4997c51` and Prospects `proc_9b4096a5b81c` at rows 5–6. The workers used canonical sessions `20260912_131104_9b74f1` and `20260912_131104_9c2ca3`.

The first GUI service restart exposed the native orphan-cleanup default described above. Research received a SIGTERM report and retried Prospects through `proc_37682d14d550`; the completion at row 12 contains handoff `LP-GUI-PROSPECTS-2026-09-12`. After the operator configured persistent sessions and supplied a recovery instruction at row 18, Research inspected the original process and worker histories, confirmed SEO had no completion receipt, preserved the existing prospect artifact, and resumed SEO through `proc_c5b5cada8a3d` at row 37.

With native orphan cleanup disabled, the Vulcan service was stopped from 12:20:25 to 12:21:21 UTC. The same SEO worker continued making tool calls during this 56-second outage. It returned handoff `launchpost-seo-logo-20260912T122324Z`, persisted in Research's native completion message at row 52. No operator relayed worker findings. Research's report at row 82 joined both worker receipts with the actual changed files and checks; its final review-correction report is persisted at row 99.

Both teams independently selected the same missing Organization-logo fix. The GUI team's five candidates were Fathom Analytics, FletchPMM, The Workflow, Resend and PostHog; every candidate has official public evidence, an explicitly hypothetical fit and a research-only next action. Independent review corrected FletchPMM's bare-domain URLs to the working `www` domain and strengthened the regression check to read the schema-referenced local asset. Those review corrections were sent to the original lead through Vulcan.

The GUI patch passed ten focused SEO tests, changed-file ESLint, typecheck, build and diff validation. A separate fresh Playwright context parsed the built homepage JSON-LD and confirmed its logo URL, then verified the existing public PNG returned 200 with `image/png` while the stale WebP returned 404. This validates the reviewed build and existing asset; production was not deployed.

This comparison demonstrates native delegation, attributable worker completions, operator review and corrected GUI-outage survival. It includes recovery interventions and different prospect choices, so it does not establish controlled timing superiority or complete migration acceptance.

### Reviewed delivery

The operator published the reviewed GUI team's result as [LaunchPost PR #143](https://github.com/AnalystTom/Hermes_hack/pull/143), commit [`bf1b98322ce51f722c83786f372485e05f743855`](https://github.com/AnalystTom/Hermes_hack/commit/bf1b98322ce51f722c83786f372485e05f743855). The final delivery branch starts at current main `c439bfadcb3ec0315e1e699557d3169f7aabf265`; the original comparison worktrees retain their frozen baseline. Review simplified redundant test path guards while preserving the actual asset-read check. The pre-commit hooks passed all 859 LaunchPost tests and typecheck, and the PR's lint/typecheck/test/build CI passed. Production deployment was skipped.

The original Bot Chat received both PR links and the final commit at row 100, then returned a linked goal report at row 111. It correctly distinguished anonymous GitHub access from the operator's authenticated receipt. The host's existing authenticated GitHub CLI can read the private business PR without another login or credential copy.

### Remaining gates

This PR does not close issue #3. Two consecutive representative runs through Vulcan, including controlled restart recovery without duplicate effects, remain required before migration. Existing team inventory/backups, ownership transfer, old-scheduler quiescence, schedule adoption, rollback and recurring-run acceptance remain separate gates. Distribution, Forkcast outreach/Rewind, site deployment and infrastructure monitoring have not been qualified by this SEO/prospect canary.
