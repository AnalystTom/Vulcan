import type { BotColor, ModelSlug, ProviderKind } from "@vulcan/contracts";
import { getDefaultModel } from "@vulcan/shared/model";
import { useMemo, useState } from "react";

import { useAppSettings } from "~/appSettings";
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

const COLORS: readonly BotColor[] = [
  "green",
  "blue",
  "red",
  "orange",
  "purple",
  "cyan",
  "pink",
  "yellow",
  "teal",
  "coral",
];

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
    color: BotColor;
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
  const [color, setColor] = useState<BotColor>("green");
  const [selection, setSelection] = useState<{ provider: ProviderKind; model: ModelSlug } | null>(
    null,
  );
  const provider = selection?.provider ?? availableProvider ?? "codex";
  const catalog = useProviderModelCatalog({ selectedProvider: provider, discoveryEnabled: open });
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
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Avatar color</p>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-label={`${value} avatar`}
                  aria-pressed={color === value}
                  className="size-7 rounded-full border-2 border-transparent bg-current aria-pressed:border-foreground"
                  style={{ color: `var(--bot-${value}, ${value})` }}
                  onClick={() => setColor(value)}
                />
              ))}
            </div>
          </div>
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
                color,
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
