// FILE: HermesBotPane.tsx
// Purpose: A Workspace Pane for one native Hermes Bot Chat, with its profile
//          selection owned by the persisted Workspace layout.

import type { WorkspacePane } from "@vulcan/contracts";
import { readPaneAttachment } from "@vulcan/shared/workspaceLayout";
import { useMemo } from "react";

import { useHermesBotsApi, useHermesProfiles, useHermesStatus } from "~/hooks/useHermesBots";

import { HermesBotChat } from "../bots/HermesBotConversation";
import { ErrorNotice, hermesProfileLabel } from "../bots/HermesBotParts";

export interface HermesBotPaneProps {
  readonly pane: WorkspacePane;
  readonly onSelectProfile: (profile: string | null) => void;
}

export function HermesBotPane({ pane, onSelectProfile }: HermesBotPaneProps) {
  const api = useHermesBotsApi();
  const status = useHermesStatus();
  const connected = status.data?.connected === true;
  const profiles = useHermesProfiles(connected);
  const availableProfiles = useMemo(
    () => (profiles.data?.profiles ?? []).filter((profile) => !profile.hidden),
    [profiles.data],
  );
  const attachment = readPaneAttachment(pane, "hermesBot");
  const selectedProfileName = attachment?.profile ?? null;
  const selectedProfile = availableProfiles.find((profile) => profile.name === selectedProfileName);

  if (!api) {
    return <PaneMessage>Hermes Bot runtime is unavailable in this Vulcan build.</PaneMessage>;
  }
  if (status.isLoading) {
    return <PaneMessage>Checking the Hermes Bot runtime…</PaneMessage>;
  }
  if (status.error) {
    return (
      <div className="p-3">
        <ErrorNotice
          title="Hermes Bot runtime unavailable"
          message={status.error instanceof Error ? status.error.message : String(status.error)}
          onRetry={() => void status.refetch()}
        />
      </div>
    );
  }
  if (!connected) {
    return (
      <PaneMessage>
        {status.data?.message ?? "Connect a Hermes gateway in Bots to use this pane."}
      </PaneMessage>
    );
  }
  if (profiles.isLoading) {
    return <PaneMessage>Loading the native Hermes profile roster…</PaneMessage>;
  }
  if (profiles.error) {
    return (
      <div className="p-3">
        <ErrorNotice
          title="Hermes profile roster unavailable"
          message={
            profiles.error instanceof Error ? profiles.error.message : String(profiles.error)
          }
          onRetry={() => void profiles.refetch()}
        />
      </div>
    );
  }
  if (availableProfiles.length === 0) {
    return <PaneMessage>No selectable Hermes profiles are available on this gateway.</PaneMessage>;
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <label
          className="flex items-center gap-2 text-xs font-medium"
          htmlFor={`hermes-profile-${pane.paneId}`}
        >
          <span>Hermes profile</span>
          <select
            id={`hermes-profile-${pane.paneId}`}
            aria-label="Hermes profile"
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 font-normal"
            value={selectedProfileName ?? ""}
            onChange={(event) => onSelectProfile(event.target.value || null)}
          >
            <option value="">Choose a profile…</option>
            {selectedProfileName && !selectedProfile ? (
              <option value={selectedProfileName} disabled>
                Saved profile unavailable: {selectedProfileName}
              </option>
            ) : null}
            {availableProfiles.map((profile) => (
              <option key={profile.name} value={profile.name}>
                {hermesProfileLabel(profile)} (@{profile.name})
              </option>
            ))}
          </select>
        </label>
      </div>
      {selectedProfile ? (
        <HermesBotChat key={selectedProfile.name} profile={selectedProfile} />
      ) : selectedProfileName ? (
        <PaneMessage>Choose another profile to open this Hermes Bot Chat.</PaneMessage>
      ) : (
        <PaneMessage>Select a native Hermes profile to open its Bot Chat.</PaneMessage>
      )}
    </div>
  );
}

function PaneMessage({ children }: { children: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
