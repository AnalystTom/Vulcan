import { useState, type FormEvent } from "react";

import { Button } from "~/components/ui/button";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";
import { Input } from "~/components/ui/input";
import { useHermesProfileDetail, type HermesProfileDetail } from "~/hooks/useHermesBots";
import {
  useHermesMcpCatalog,
  useHermesMcpMutations,
  useHermesMcpServers,
  type HermesMcpServer,
} from "~/hooks/useHermesConnections";

import { ErrorNotice, SectionHeading } from "./HermesBotParts";
import { HermesMcpSignIn } from "./HermesMcpSignIn";

function connectionGranted(detail: HermesProfileDetail, name: string): boolean {
  const configured = detail.mcpServers.some((server) => server.name === name && server.enabled);
  if (!configured || !detail.toolsetsPinned) return configured;
  return (
    detail.enabledToolsets !== null &&
    !detail.enabledToolsets.includes("no_mcp") &&
    detail.enabledToolsets.includes(name)
  );
}

function ConnectionRow({
  profile,
  server,
  detail,
}: {
  profile: string;
  server: HermesMcpServer;
  detail: HermesProfileDetail;
}) {
  const actions = useHermesMcpMutations(profile);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const granted = connectionGranted(detail, server.name);
  const pinUnavailable = detail.toolsetsPinned && detail.enabledToolsets === null;
  const busy =
    signingIn || actions.test.isPending || actions.grant.isPending || actions.remove.isPending;
  const grant = async (allow: boolean) => {
    setError(null);
    try {
      await actions.grant.mutateAsync({ name: server.name, enabled: allow });
    } catch {
      setError("Access could not be updated. The saved settings will be reloaded.");
    }
  };
  const test = actions.test.data;
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">{server.name}</p>
          <p className="text-xs text-muted-foreground">
            {server.oauthTokensPresent === true
              ? "Sign-in saved; check the connection below."
              : server.auth === "oauth"
                ? "Sign-in required."
                : server.auth === "header"
                  ? "Access-token authentication; check the connection below."
                  : "Configured; connection not yet checked."}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            void actions.test.mutateAsync({ name: server.name }).catch(() => undefined);
          }}
        >
          {actions.test.isPending ? "Checking…" : "Check connection"}
        </Button>
      </div>
      {test ? (
        <p role="status" className="text-xs text-muted-foreground">
          {test.ok
            ? `Last connection check: ${test.tools.length} tools available.`
            : test.oauthNeeded && test.oauthTokensPresent === false
              ? "Sign in to check this connection."
              : "Connection check failed. Review its sign-in or access key."}
        </p>
      ) : null}
      {server.transport === "http" && server.auth !== "header" ? (
        <HermesMcpSignIn
          profile={profile}
          name={server.name}
          disabled={busy}
          onBusyChange={setSigningIn}
        />
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={granted}
          disabled={busy || pinUnavailable}
          onChange={(event) => void grant(event.target.checked)}
        />
        Allow this worker to use the connection
      </label>
      {pinUnavailable ? (
        <p className="text-xs text-muted-foreground">
          Update Hermes to expose this profile’s complete tool selection before changing access.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={() => {
          void actions.remove.mutateAsync({ name: server.name }).catch(() => undefined);
        }}
      >
        Remove connection
      </Button>
    </div>
  );
}

export function HermesConnectionsPanel({ profile }: { profile: string }) {
  const servers = useHermesMcpServers(profile);
  const detail = useHermesProfileDetail(profile);
  const [adding, setAdding] = useState(false);
  const catalog = useHermesMcpCatalog(profile, adding);
  const actions = useHermesMcpMutations(profile);
  const [preset, setPreset] = useState("");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"oauth" | "header" | "none">("oauth");
  const [formError, setFormError] = useState<string | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const token = values.get("access-token");
    setFormError(null);
    try {
      await actions.add.mutateAsync({
        name: name.trim(),
        ...(preset ? { preset } : { url: url.trim() }),
        ...(auth !== "none" ? { auth } : {}),
        ...(auth === "header" && typeof token === "string" ? { bearerToken: token } : {}),
      });
      setAdding(false);
      setName("");
      setUrl("");
      setPreset("");
    } catch {
      setFormError("The connection could not be saved. Check its settings and try again.");
    } finally {
      const input = form.elements.namedItem("access-token");
      if (input instanceof HTMLInputElement) input.value = "";
      actions.add.reset();
    }
  };
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <SectionHeading
        title="Accounts & connections"
        description="Set up a connection, check it, then grant this worker access."
      />
      {servers.isLoading || detail.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading connections…</p>
      ) : null}
      {servers.error || detail.error ? (
        <ErrorNotice
          title="Could not load connections"
          message="Check the Hermes connection and try again."
          onRetry={() => {
            void servers.refetch();
            void detail.refetch();
          }}
        />
      ) : null}
      {servers.data && detail.data ? (
        servers.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No connections configured for this worker.
          </p>
        ) : (
          servers.data.map((server) => (
            <ConnectionRow
              key={server.name}
              profile={profile}
              server={server}
              detail={detail.data!}
            />
          ))
        )
      ) : null}
      <button
        type="button"
        className="flex items-center gap-2 text-sm"
        aria-expanded={adding}
        onClick={() => setAdding((current) => !current)}
      >
        <DisclosureChevron open={adding} /> Add connection
      </button>
      <DisclosureRegion open={adding}>
        <form onSubmit={(event) => void submit(event)} className="space-y-3 pt-3">
          <label className="block space-y-1 text-sm">
            Service
            <select
              className="block w-full rounded-md border border-border bg-background p-2"
              value={preset}
              onChange={(event) => {
                setPreset(event.target.value);
                if (event.target.value) setName(event.target.value);
              }}
            >
              <option value="">Custom HTTP service</option>
              {catalog.data
                ?.filter((entry) => entry.transport === "http")
                .map((entry) => (
                  <option key={entry.name} value={entry.name}>
                    {entry.name}
                  </option>
                ))}
            </select>
          </label>
          {catalog.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading available services…</p>
          ) : null}
          {catalog.error ? (
            <p className="text-xs text-destructive">
              The service catalog is unavailable. You can enter a service address.
            </p>
          ) : null}
          <label className="block space-y-1 text-sm">
            Connection name
            <Input required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          {!preset ? (
            <label className="block space-y-1 text-sm">
              Service URL
              <Input
                type="url"
                required
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </label>
          ) : null}
          <label className="block space-y-1 text-sm">
            Authentication
            <select
              className="block w-full rounded-md border border-border bg-background p-2"
              value={auth}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "oauth" || value === "header" || value === "none") setAuth(value);
              }}
            >
              <option value="oauth">Browser sign-in</option>
              <option value="header">Access token</option>
              <option value="none">None</option>
            </select>
          </label>
          {auth === "header" ? (
            <label className="block space-y-1 text-sm">
              Access token
              <Input name="access-token" type="password" autoComplete="off" required />
            </label>
          ) : null}
          {formError ? (
            <p role="alert" className="text-xs text-destructive">
              {formError}
            </p>
          ) : null}
          <Button type="submit" disabled={actions.add.isPending}>
            {actions.add.isPending ? "Saving…" : "Save connection"}
          </Button>
        </form>
      </DisclosureRegion>
    </section>
  );
}
