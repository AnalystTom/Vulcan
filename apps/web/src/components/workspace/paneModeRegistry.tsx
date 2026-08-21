// FILE: paneModeRegistry.tsx
// Purpose: One place that says what each Pane Mode is called, what icon it uses,
// and whether it is actually implemented yet.
// Layer: Workspace UI
//
// The registry is the single taxonomy shared by the mode picker, the Pane header,
// persistence, and factory automation. A mode that is declared but not built
// renders an explicit "not available yet" surface rather than an empty Pane, and
// is kept out of the picker -- so an operator is never offered something that
// silently does nothing.

import { type PaneMode, IMPLEMENTED_PANE_MODES } from "@vulcan/contracts";
import {
  IconBrandChrome,
  IconGitCompare,
  IconMessage,
  IconRoute,
  IconSitemap,
  IconTerminal2,
  type Icon,
  IconEye,
} from "@tabler/icons-react";

export interface PaneModeDescriptor {
  readonly mode: PaneMode;
  readonly label: string;
  /** One line explaining the mode, shown in the picker. */
  readonly description: string;
  readonly Icon: Icon;
  readonly implemented: boolean;
}

const IMPLEMENTED = new Set<PaneMode>(IMPLEMENTED_PANE_MODES);

const DESCRIPTORS: readonly Omit<PaneModeDescriptor, "implemented">[] = [
  {
    mode: "agent",
    label: "Agent",
    description: "The native agent conversation, composer, and working surface.",
    Icon: IconMessage,
  },
  {
    mode: "herdrTerminal",
    label: "Herdr Terminal",
    description: "A durable Herdr terminal that survives restarts and reconnects.",
    Icon: IconTerminal2,
  },
  {
    mode: "browser",
    label: "Browser",
    description: "A live preview of the running application.",
    Icon: IconBrandChrome,
  },
  {
    mode: "diff",
    label: "Diff",
    description: "Changed files for the current revision.",
    Icon: IconGitCompare,
  },
  {
    mode: "factory",
    label: "Factory",
    description: "The workflow graph, waterfall, and activity board for this run.",
    Icon: IconSitemap,
  },
  {
    mode: "trace",
    label: "Agent Traces",
    description: "Captured local Tapes sessions and their provider spans.",
    Icon: IconRoute,
  },
  {
    mode: "lavishReview",
    label: "Lavish Review",
    description: "A visual review surface for UI-affecting changes.",
    Icon: IconEye,
  },
];

export const PANE_MODE_DESCRIPTORS: readonly PaneModeDescriptor[] = DESCRIPTORS.map(
  (descriptor) => ({ ...descriptor, implemented: IMPLEMENTED.has(descriptor.mode) }),
);

const BY_MODE = new Map(PANE_MODE_DESCRIPTORS.map((descriptor) => [descriptor.mode, descriptor]));

export function describePaneMode(mode: PaneMode): PaneModeDescriptor {
  const descriptor = BY_MODE.get(mode);
  if (descriptor) return descriptor;
  // Reached only if persistence holds a mode this build does not know, e.g. after
  // a downgrade. Naming it is more useful than crashing the whole grid.
  return {
    mode,
    label: mode,
    description: "This pane mode is not available in this build.",
    Icon: IconMessage,
    implemented: false,
  };
}

/** Modes offered in the picker: only the ones that actually render something. */
export const SELECTABLE_PANE_MODES: readonly PaneModeDescriptor[] = PANE_MODE_DESCRIPTORS.filter(
  (descriptor) => descriptor.implemented,
);
