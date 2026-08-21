// FILE: RemoteAccessSettingsPanel.tsx
// Purpose: Let the owner create one-time mobile pairing links and revoke connected clients.
// Layer: Settings UI component

import type {
  AuthClientSession,
  AuthPairingCredentialResult,
  AuthSessionState,
  ServerConfig,
} from "@vulcan/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { toastManager } from "~/components/ui/toast";
import { copyTextToClipboard } from "~/hooks/useCopyToClipboard";
import { ensureNativeApi } from "~/nativeApi";
import {
  SettingsEmptyState,
  SettingsListRow,
  SettingsRow,
  SettingsSection,
  SettingsSectionShell,
  SettingsCard,
} from "./SettingsPanelPrimitives";

const AUTH_PAIRING_LINKS_QUERY_KEY = ["server", "auth", "pairingLinks"] as const;
const AUTH_CLIENTS_QUERY_KEY = ["server", "auth", "clients"] as const;
const DEFAULT_DEVICE_LABEL = "My phone";

function formatDate(value: string | null | undefined): string {
  if (!value) return "Never";
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) ? value : new Date(milliseconds).toLocaleString();
}

function clientTitle(session: AuthClientSession): string {
  const inferredTitle = [session.client.os, session.client.browser].filter(Boolean).join(" · ");
  return (session.client.label ?? inferredTitle) || "Unknown device";
}

function clientDescription(session: AuthClientSession): string {
  const device = [session.client.deviceType, session.client.os, session.client.browser]
    .filter(Boolean)
    .join(" · ");
  const status = session.connected
    ? "Connected now"
    : `Last connected ${formatDate(session.lastConnectedAt)}`;
  return `${session.role === "owner" ? "Owner" : "Client"} · ${device} · ${status}`;
}

function resolvePairingOrigin(config: ServerConfig | undefined): string | null {
  if (config?.remoteAccessUrl) return config.remoteAccessUrl.replace(/\/$/u, "");
  if (typeof window === "undefined") return null;
  return window.location.protocol === "http:" || window.location.protocol === "https:"
    ? window.location.origin
    : null;
}

function pairingUrl(origin: string, credential: string): string {
  return `${origin}/pair#token=${encodeURIComponent(credential)}`;
}

function copyPairingLink(value: string): void {
  void copyTextToClipboard(value).then(
    () => toastManager.add({ type: "success", title: "Pairing link copied" }),
    (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not copy pairing link",
        description: error instanceof Error ? error.message : "Clipboard access failed.",
      }),
  );
}

export function RemoteAccessSettingsPanel(props: {
  active: boolean;
  authSession: AuthSessionState | undefined;
  config: ServerConfig | undefined;
}) {
  const queryClient = useQueryClient();
  const [deviceLabel, setDeviceLabel] = useState(DEFAULT_DEVICE_LABEL);
  const [createdPairing, setCreatedPairing] = useState<AuthPairingCredentialResult | null>(null);
  const isOwner = props.authSession?.authenticated === true && props.authSession.role === "owner";
  const pairingOrigin = useMemo(() => resolvePairingOrigin(props.config), [props.config]);
  const createdPairingUrl =
    createdPairing && pairingOrigin ? pairingUrl(pairingOrigin, createdPairing.credential) : null;

  const pairingLinksQuery = useQuery({
    queryKey: AUTH_PAIRING_LINKS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listAuthPairingLinks(),
    enabled: props.active && isOwner,
    staleTime: 5_000,
  });
  const clientsQuery = useQuery({
    queryKey: AUTH_CLIENTS_QUERY_KEY,
    queryFn: () => ensureNativeApi().server.listAuthClients(),
    enabled: props.active && isOwner,
    staleTime: 5_000,
    refetchOnWindowFocus: true,
  });

  const createPairingMutation = useMutation({
    mutationFn: () =>
      ensureNativeApi().server.createAuthPairingToken({ label: deviceLabel.trim() }),
    onSuccess: (result) => {
      setCreatedPairing(result);
      void queryClient.invalidateQueries({ queryKey: AUTH_PAIRING_LINKS_QUERY_KEY });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not create pairing link",
        description: error instanceof Error ? error.message : "Pairing failed.",
      }),
  });

  const revokeClientMutation = useMutation({
    mutationFn: (sessionId: AuthClientSession["sessionId"]) =>
      ensureNativeApi().server.revokeAuthClient({ sessionId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: AUTH_CLIENTS_QUERY_KEY });
      toastManager.add({
        type: "success",
        title: "Device revoked",
        description: "That browser must pair again before it can reconnect.",
      });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not revoke device",
        description: error instanceof Error ? error.message : "Revocation failed.",
      }),
  });

  const revokePairingMutation = useMutation({
    mutationFn: (id: string) => ensureNativeApi().server.revokeAuthPairingLink({ id }),
    onSuccess: (_result, id) => {
      if (createdPairing?.id === id) setCreatedPairing(null);
      void queryClient.invalidateQueries({ queryKey: AUTH_PAIRING_LINKS_QUERY_KEY });
    },
    onError: (error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Could not revoke pairing link",
        description: error instanceof Error ? error.message : "Revocation failed.",
      }),
  });

  if (!props.active) return null;

  if (props.authSession === undefined) {
    return <SettingsEmptyState>Loading access information...</SettingsEmptyState>;
  }

  if (!isOwner) {
    return (
      <SettingsSection title="This device">
        <SettingsRow
          title="Connected as a client"
          description="Only the owner device can pair or revoke other devices. This child session can use Vulcan but cannot manage access."
          status="Ask the owner to create a new pairing link when another device needs access."
        />
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection title="Pair another device">
        <SettingsRow
          title="Pair another device"
          description="Create a one-time link for your phone or another browser. The link expires after five minutes and works once."
          status={
            pairingOrigin
              ? `Devices connect to ${pairingOrigin}.`
              : "Configure an HTTPS remote access URL, or open Vulcan from its remote web address, before copying this link to another device."
          }
          control={
            <div className="flex w-full gap-2 sm:w-auto">
              <Input
                size="sm"
                variant="soft"
                aria-label="Device name"
                value={deviceLabel}
                maxLength={80}
                onChange={(event) => setDeviceLabel(event.target.value)}
              />
              <Button
                size="xs"
                disabled={deviceLabel.trim().length === 0 || createPairingMutation.isPending}
                onClick={() => createPairingMutation.mutate()}
              >
                {createPairingMutation.isPending ? "Creating..." : "Create pairing link"}
              </Button>
            </div>
          }
        >
          {createdPairing ? (
            <div className="mt-3 space-y-2 rounded-lg border border-border/70 bg-muted/30 p-3">
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  readOnly
                  aria-label="New pairing link"
                  value={createdPairingUrl ?? createdPairing.credential}
                  className="min-w-0 flex-1 font-mono text-xs"
                />
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => copyPairingLink(createdPairingUrl ?? createdPairing.credential)}
                >
                  Copy link
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Expires {formatDate(createdPairing.expiresAt)}. Open it on the named device only.
              </p>
            </div>
          ) : null}
        </SettingsRow>
      </SettingsSection>

      {pairingLinksQuery.data?.length ? (
        <SettingsSectionShell title="Pending pairing links">
          <SettingsCard>
            {pairingLinksQuery.data.map((link) => (
              <SettingsListRow
                key={link.id}
                title={link.label ?? "Unnamed device"}
                description={`Expires ${formatDate(link.expiresAt)}`}
                actions={
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={revokePairingMutation.isPending}
                    onClick={() => revokePairingMutation.mutate(link.id)}
                  >
                    Revoke link
                  </Button>
                }
              />
            ))}
          </SettingsCard>
        </SettingsSectionShell>
      ) : null}

      <SettingsSectionShell title="Connected devices">
        {clientsQuery.isLoading ? (
          <SettingsEmptyState layout="status">Loading connected devices...</SettingsEmptyState>
        ) : clientsQuery.isError ? (
          <SettingsEmptyState layout="status" tone="destructive">
            Could not load connected devices.
          </SettingsEmptyState>
        ) : clientsQuery.data?.length ? (
          <SettingsCard>
            {clientsQuery.data.map((session) => {
              const title = clientTitle(session);
              return (
                <SettingsListRow
                  key={session.sessionId}
                  title={session.current ? `${title} (this device)` : title}
                  description={clientDescription(session)}
                  actions={
                    session.current ? null : (
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        aria-label={`Revoke ${title}`}
                        disabled={revokeClientMutation.isPending}
                        onClick={() => revokeClientMutation.mutate(session.sessionId)}
                      >
                        Revoke
                      </Button>
                    )
                  }
                />
              );
            })}
          </SettingsCard>
        ) : (
          <SettingsEmptyState layout="status">
            No paired clients yet. Create a link above and open it on your phone.
          </SettingsEmptyState>
        )}
      </SettingsSectionShell>
    </div>
  );
}
