# Provenance

This file records where Vulcan's source came from, so that the MIT attribution obligations of both
upstream projects can be audited against a concrete revision rather than inferred from the diff.

## Source revision

| Field                   | Value                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Upstream project        | Synara                                                                                  |
| Upstream repository     | <https://github.com/Emanuele-web04/synara>                                              |
| Upstream revision       | `ce8728c47c853a6420adca0ce0925bfed67a0d7c`                                              |
| Upstream commit date    | 2026-08-09                                                                              |
| Upstream commit subject | `Use inset macOS artwork for app icon picker`                                           |
| Upstream license        | MIT                                                                                     |
| Clone taken             | 2026-08-09                                                                              |
| Method                  | `git clone --depth 1`, tracked files copied without `.git`; no fork, no upstream remote |

Synara in turn began as a clone of [T3Code](https://github.com/pingdotgg/t3code) (MIT, T3 Tools Inc.).
`LICENSE` therefore carries three copyright lines: T3 Tools Inc., Emanuele Di Pietro, and Vulcan
contributors.

## Relationship to upstream

Vulcan is **not** a GitHub fork of Synara. There is no `upstream` remote, and no automated sync
relationship is maintained. Upstream fixes may be read and reimplemented, but ordinary development
does not merge from Synara. This is a deliberate constraint from
[issue #1](https://github.com/AnalystTom/Agent_panel/issues/1).

## What was removed from the clone

Removed because it is upstream product history or upstream visual identity, and could not be honestly
rebranded:

| Path                                                                                               | Reason                                                                |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/marketing/`                                                                                  | Synara's marketing website, including Synara product screenshots      |
| `assets/prod/readme-screenshot.jpeg`                                                               | Screenshot of the Synara UI                                           |
| `assets/prod/logo.svg`, `apps/web/public/*-logo.svg`, logo path module                             | Synara's antler wordmark; replaced with an original Vulcan anvil mark |
| `CHANGELOG.md` (contents)                                                                          | Synara release history; reset to start at Vulcan's fork point         |
| `apps/web/src/whatsNew/entries.ts` (contents)                                                      | Synara's in-app release notes; reset                                  |
| `.plans/`, `plans/`, `advisor-plans/`, `audit/`, `benchmarks/`                                     | Upstream planning and audit artifacts                                 |
| `docs/RECAP-*.md`, `docs/plans/`, `docs/pr-screenshots/`, `docs/repo-scan-*/`, `docs/performance/` | Upstream per-change work recaps                                       |
| `TODO.md`                                                                                          | Upstream task list                                                    |

## What was renamed

The brand rewrite was mechanical and ordered, applied to text files only:

| From                              | To                                                    |
| --------------------------------- | ----------------------------------------------------- |
| `com.emanueledipietro.synara`     | `com.vulcanapp.vulcan`                                |
| `Emanuele-web04/synara`           | `AnalystTom/Agent_panel` (except in attribution text) |
| `trysynara.com`                   | `github.com/AnalystTom/Agent_panel`                   |
| `SYNARA_*`                        | `VULCAN_*` (environment variables)                    |
| `@synara/*`                       | `@vulcan/*` (package scope)                           |
| `Synara` / `synara`               | `Vulcan` / `vulcan`                                   |
| `~/.synara`, `~/Documents/Synara` | `~/.vulcan`, `~/Documents/Vulcan`                     |

Database migration ids and names were deliberately **not** touched. Migration lineage is checked by
`bun run migrations:check`, and renaming a released migration would break it.

## Attribution guard

`bun run brand:check` (`scripts/check-brand-identity.ts`) fails the build if a retired first-party
identity — `Synara`, or the identities Synara itself retired (`T3 Code`, `T3 Tools`, `dpcode`,
`codething`) — reappears in a tracked file. The only permitted occurrences are the attribution lines
enumerated in that script: the `LICENSE` copyright notices, the `## Origins` section of `README.md`,
and this file. Adding a new occurrence requires adding it to that allow list, which makes every
attribution change an explicit, reviewed act.
