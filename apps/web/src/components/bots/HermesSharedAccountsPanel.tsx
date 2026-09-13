import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import type { HermesBotMethod, HermesBotRequest } from "@vulcan/contracts";
import { readNativeApi } from "~/nativeApi";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { DisclosureChevron } from "~/components/ui/DisclosureChevron";
import { DisclosureRegion } from "~/components/ui/DisclosureRegion";

const AccountView = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  enabled: Schema.Boolean,
  credentialConfigured: Schema.Boolean,
  profileGrants: Schema.Array(
    Schema.Struct({ profile: Schema.String, allowedTools: Schema.Array(Schema.String) }),
  ),
});
type Account = typeof AccountView.Type;
const AccountsResponse = Schema.Struct({ connections: Schema.Array(AccountView) });
const CheckResponse = Schema.Struct({
  ok: Schema.Boolean,
  tools: Schema.Array(Schema.Struct({ name: Schema.String })),
});
type Check = typeof CheckResponse.Type;
const KEY = ["hermes-bots", "shared-accounts"] as const;

async function request(method: HermesBotMethod, params: HermesBotRequest["params"] = {}) {
  const api = readNativeApi()?.hermesBots;
  if (!api) throw new Error("Shared accounts are unavailable.");
  return api.request({ method, params });
}

function useAccountAction() {
  const client = useQueryClient();
  return useMutation({
    gcTime: 0,
    mutationFn: ({ method, params }: HermesBotRequest) => request(method, params),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: KEY });
      void client.invalidateQueries({ queryKey: ["hermes-bots", "detail"] });
      void client.invalidateQueries({ queryKey: ["hermes-bots", "profiles"] });
    },
  });
}

function SharedAccountRow({ account, profile }: { account: Account; profile: string }) {
  const action = useAccountAction();
  const [check, setCheck] = useState<Check | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const saved =
    account.profileGrants.find((grant) => grant.profile === profile)?.allowedTools ?? [];
  const savedKey = JSON.stringify(saved);
  const [selected, setSelected] = useState<string[]>([...saved]);
  const [brokerUrl, setBrokerUrl] = useState(window.location.origin);
  useEffect(() => {
    setSelected(JSON.parse(savedKey));
  }, [savedKey]);
  const run = async (method: HermesBotMethod, params: HermesBotRequest["params"]) => {
    setError(null);
    try {
      const result = await action.mutateAsync({ method, params });
      if (method === "vulcan.accounts.check") {
        setCheck(Schema.decodeUnknownSync(CheckResponse)(result));
      } else if (
        Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Boolean }))(result).ok !== true
      ) {
        throw new Error("Not confirmed");
      }
      return true;
    } catch {
      setError("The request could not be confirmed. Reload the account state before retrying.");
      return false;
    } finally {
      action.reset();
    }
  };
  const replaceToken = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = event.currentTarget.elements.namedItem("credential") as HTMLInputElement;
    try {
      if (
        await run("vulcan.accounts.save", {
          id: account.id,
          name: account.name,
          url: account.url,
          enabled: account.enabled,
          credential: token.value,
        })
      ) {
        setCheck(null);
        setReplacing(false);
      }
    } finally {
      token.value = "";
    }
  };
  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">{account.name}</p>
        <p className="break-all text-xs text-muted-foreground">{account.url}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {account.credentialConfigured
          ? "Access token saved. Check the connection to verify access."
          : "Access token needed."}{" "}
        {account.enabled ? "" : "This account is disabled."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={action.isPending}
          onClick={() => {
            void run("vulcan.accounts.check", { id: account.id });
          }}
        >
          Check shared account
        </Button>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={replacing}
          onClick={() => setReplacing(!replacing)}
        >
          <DisclosureChevron open={replacing} />
          Replace access token
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={action.isPending}
          onClick={() => {
            void run("vulcan.accounts.remove", { id: account.id });
          }}
        >
          Remove account and all grants
        </Button>
      </div>
      <DisclosureRegion open={replacing}>
        <form className="space-y-2 pt-2" onSubmit={(event) => void replaceToken(event)}>
          <label className="block text-sm">
            New shared access token
            <Input name="credential" type="password" autoComplete="off" required />
          </label>
          <Button size="sm" type="submit" disabled={action.isPending}>
            Replace token
          </Button>
        </form>
      </DisclosureRegion>
      {check ? (
        <p role="status" className="text-xs text-muted-foreground">
          {check.ok
            ? `Last connection check succeeded: ${check.tools.length} tools available.`
            : "Connection check failed. Review this account's access token and service."}
        </p>
      ) : null}
      <p className="text-sm">Tools allowed for @{profile}</p>
      {check?.ok ? (
        <div className="max-h-60 space-y-1 overflow-auto">
          {check.tools.map((tool) => (
            <label key={tool.name} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(tool.name)}
                disabled={action.isPending}
                onChange={(event) =>
                  setSelected((values) =>
                    event.target.checked
                      ? [...values, tool.name]
                      : values.filter((name) => name !== tool.name),
                  )
                }
              />
              {tool.name}
            </label>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {saved.length
            ? `Currently granted: ${saved.join(", ")}. Check this account to edit its tools.`
            : "No tools granted. Check this account to choose tools."}
        </p>
      )}
      <label className="block space-y-1 text-xs text-muted-foreground">
        Vulcan address reachable from Hermes
        <Input
          type="url"
          value={brokerUrl}
          onChange={(event) => setBrokerUrl(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={action.isPending || !account.enabled || !check?.ok || selected.length === 0}
          onClick={() => {
            void run("vulcan.accounts.grant", {
              id: account.id,
              profile,
              allowedTools: selected,
              brokerUrl,
            });
          }}
        >
          Allow selected tools
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={action.isPending || saved.length === 0}
          onClick={() => {
            void run("vulcan.accounts.revoke", { id: account.id, profile });
          }}
        >
          Revoke this worker's access
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Granted to {account.profileGrants.length} worker
        {account.profileGrants.length === 1 ? "" : "s"}. Removing the account removes access for
        every worker.
      </p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function HermesSharedAccountsPanel({ profile }: { profile: string }) {
  const accounts = useQuery({
    queryKey: KEY,
    queryFn: async () =>
      Schema.decodeUnknownSync(AccountsResponse)(await request("vulcan.accounts.list")),
    retry: false,
  });
  const action = useAccountAction();
  const [adding, setAdding] = useState(false);
  const [id, setId] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const field = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
    const credential = field("credential");
    setError(null);
    try {
      const result = await action.mutateAsync({
        method: "vulcan.accounts.save",
        params: {
          id,
          name: field("name").value,
          url: field("url").value,
          enabled: true,
          credential: credential.value,
        },
      });
      if (!Schema.decodeUnknownSync(Schema.Struct({ ok: Schema.Boolean }))(result).ok)
        throw new Error("Not confirmed");
      form.reset();
      setId(crypto.randomUUID());
      setAdding(false);
    } catch {
      setError("Account save could not be confirmed. Check the account list before trying again.");
    } finally {
      credential.value = "";
      action.reset();
    }
  };
  return (
    <section className="space-y-3 border-t border-border pt-5">
      <h3 className="text-sm font-medium">Shared accounts</h3>
      <p className="text-xs text-muted-foreground">
        Save a service's access token once, then choose tools for each worker. Supports services
        that accept bearer tokens and JSON MCP requests. Other sign-in methods use native
        connections above.
      </p>
      {accounts.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading shared accounts…</p>
      ) : accounts.error ? (
        <p role="alert" className="text-sm text-destructive">
          Shared accounts could not be loaded.
        </p>
      ) : accounts.data?.connections.length === 0 ? (
        <p className="text-sm text-muted-foreground">No shared accounts configured.</p>
      ) : null}
      {accounts.data?.connections.map((account) => (
        <SharedAccountRow key={`${profile}:${account.id}`} account={account} profile={profile} />
      ))}
      <button
        type="button"
        className="flex items-center gap-2 text-sm"
        aria-expanded={adding}
        onClick={() => setAdding(!adding)}
      >
        <DisclosureChevron open={adding} />
        Add shared account
      </button>
      <DisclosureRegion open={adding}>
        <form className="space-y-3 pt-3" onSubmit={(event) => void save(event)}>
          <label className="block space-y-1 text-sm">
            Account name
            <Input name="name" required />
          </label>
          <label className="block space-y-1 text-sm">
            Service HTTPS URL
            <Input name="url" type="url" required />
          </label>
          <label className="block space-y-1 text-sm">
            Shared access token
            <Input name="credential" type="password" autoComplete="off" required />
          </label>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" disabled={action.isPending}>
            Save shared account
          </Button>
        </form>
      </DisclosureRegion>
    </section>
  );
}
