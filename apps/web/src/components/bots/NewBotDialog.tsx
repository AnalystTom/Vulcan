import {
  DEFAULT_BOT_AVATAR,
  type BotAvatar,
  type ModelSlug,
  type ProviderKind,
} from "@vulcan/contracts";
import { getDefaultModel } from "@vulcan/shared/model";
import { useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
import { BotAvatarPicker } from "~/components/bots/BotAvatarPicker";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";

export function NewBotDialog({
  open,
  onOpenChange,
  onCreate,
  pending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: {
    name: string;
    title: string;
    description: string;
    avatar: BotAvatar;
    provider: ProviderKind;
    model: ModelSlug;
  }) => Promise<void>;
  pending: boolean;
}) {
  const statuses = useProviderStatusesForLocalConfig();
  const availableProvider = statuses.find(
    (status) => status.available && status.authStatus !== "unauthenticated",
  )?.provider;
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [avatar, setAvatar] = useState<BotAvatar>(DEFAULT_BOT_AVATAR);
  const [selection, setSelection] = useState<{
    provider: ProviderKind;
    model: ModelSlug;
  } | null>(null);
  const provider = selection?.provider ?? availableProvider ?? "codex";
  const catalog = useProviderModelCatalog({
    selectedProvider: provider,
    discoveryEnabled: open,
  });
  const defaultModel = useMemo(
    () =>
      (catalog.modelOptionsByProvider[provider][0]?.slug ??
        getDefaultModel(provider) ??
        "") as ModelSlug,
    [catalog.modelOptionsByProvider, provider],
  );
  const model = selection?.model ?? defaultModel;
  const { settings } = useAppSettings();
  const unavailable = !availableProvider || !model;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Create a persistent teammate with its own memory and tasks.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block space-y-1.5 text-xs font-medium">
            Name
            <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            Role
            <Input value={title} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="block space-y-1.5 text-xs font-medium">
            About
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="What should this agent own?"
            />
          </label>
          <BotAvatarPicker avatar={avatar} name={name} onChange={setAvatar} />
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Model</p>
            {availableProvider && model ? (
              <ProviderModelPicker
                provider={provider}
                model={model}
                lockedProvider={null}
                providers={[...statuses]}
                modelOptionsByProvider={catalog.modelOptionsByProvider}
                loadingModelProviders={catalog.loadingModelProviders}
                hiddenProviders={settings.hiddenProviders}
                providerOrder={settings.providerOrder}
                onProviderModelChange={(nextProvider, nextModel) =>
                  setSelection({ provider: nextProvider, model: nextModel })
                }
              />
            ) : (
              <p className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                No signed-in provider is available. Configure a provider before creating an agent.
              </p>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={pending || unavailable || name.trim().length === 0}
            onClick={() =>
              void onCreate({
                name: name.trim(),
                title: title.trim(),
                description: description.trim(),
                avatar,
                provider,
                model,
              })
            }
          >
            {pending ? "Creating…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
