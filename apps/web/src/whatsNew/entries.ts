// FILE: whatsNew/entries.ts
// Purpose: Curated "What's new" changelog rendered in the post-update dialog
// and the settings Release history view.
// Layer: static data consumed by `useWhatsNew`, `WhatsNewDialog`, and
// `ChangelogAccordion`.
//
// Authoring guide
// ---------------
//   - Prepend new releases so the file reads newest-first (the UI sorts too,
//     but keeping the source tidy makes PRs easier to review).
//   - `version` must match `apps/web/package.json#version` exactly. The
//     logic compares versions as semver and only opens the dialog when the
//     installed build has a curated entry here.
//   - `date` is rendered verbatim — pick whatever format you want (e.g.
//     `"Apr 18"`, `"2026-04-18"`), just be consistent release-to-release.
//   - Each feature takes an `id` (stable, unique per release), a short
//     `title`, a marketing `description`, and optionally an `image`
//     (absolute path from `apps/web/public`, e.g. `/whats-new/0.1.0/foo.png`)
//     plus `details` for the longer technical note shown under the image.
//
// This file was reset at Vulcan's fork point. The upstream project's release
// notes are not reproduced here; see PROVENANCE.md for the upstream revision.

import type { WhatsNewEntry } from "./logic";

export const WHATS_NEW_ENTRIES: readonly WhatsNewEntry[] = [
  {
    version: "0.1.0",
    date: "2026-08-09",
    features: [
      {
        id: "vulcan-initial",
        title: "Vulcan is a software factory control plane",
        description:
          "The unit of work is a declarative, executable, observable workflow rather than a chat transcript.",
        details:
          "Vulcan keeps the native multi-provider agent experience it inherited and adds a Software Factory kernel that owns Workflow Definitions, execution scheduling, target leases, retries, budgets, evidence-bearing gates, approvals, and completion. Vulcan is a temporary codename.",
      },
    ],
  },
];
