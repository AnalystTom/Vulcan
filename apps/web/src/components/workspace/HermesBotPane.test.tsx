import type { PaneId, WorkspacePane } from "@vulcan/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/hooks/useHermesBots", () => ({
  useHermesBotsApi: () => ({}),
  useHermesStatus: () => ({
    data: { connected: true },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useHermesProfiles: () => ({
    data: {
      profiles: [
        {
          name: "research",
          displayName: "Research",
          description: "",
          title: "Research lead",
          hidden: false,
          isDefault: false,
          provider: "openai",
          model: "gpt-5.6-luna",
          skillCount: 0,
          hasAvatar: false,
          canonical: null,
          lastSession: null,
          workerLastActiveIso: null,
          uiMetaRevision: null,
        },
      ],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../bots/HermesBotConversation", () => ({
  HermesBotChat: ({ profile }: { profile: { name: string } }) => (
    <div data-testid="hermes-chat">Native chat for @{profile.name}</div>
  ),
}));

vi.mock("../bots/HermesBotParts", () => ({
  ErrorNotice: () => <div>error</div>,
  hermesProfileLabel: (profile: { title: string | null; displayName: string; name: string }) =>
    profile.title?.trim() || profile.displayName.trim() || profile.name,
}));

import { HermesBotPane } from "./HermesBotPane";

const pane = {
  paneId: "pane-1" as PaneId,
  mode: "hermesBot",
  attachments: [{ mode: "hermesBot", profile: "research" }],
  pinned: false,
} satisfies WorkspacePane;

describe("HermesBotPane", () => {
  it("renders a real native roster profile selected by the persisted attachment", () => {
    const markup = renderToStaticMarkup(<HermesBotPane pane={pane} onSelectProfile={vi.fn()} />);

    expect(markup).toContain('aria-label="Hermes profile"');
    expect(markup).toContain("Research lead (@research)");
    expect(markup).toContain("Native chat for @research");
  });
});
