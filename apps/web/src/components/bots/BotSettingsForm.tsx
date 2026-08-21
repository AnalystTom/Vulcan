import {
  type Bot,
  type BotCapability as BotCapabilityType,
  type BotUpdateInput,
} from "@vulcan/contracts";
import { useState } from "react";

import { useAppSettings } from "~/appSettings";
import { ProviderModelPicker } from "~/components/chat/ProviderModelPicker";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { useProviderModelCatalog } from "~/hooks/useProviderModelCatalog";
import { useProviderStatusesForLocalConfig } from "~/hooks/useProviderStatusesForLocalConfig";

const BOT_CAPABILITIES = [
  "thread.read",
  "thread.write",
  "automation.write",
  "browser.read",
  "browser.control",
  "filesystem.read",
  "filesystem.write",
  "shell.execute",
  "network.external",
  "peer.message",
] as const satisfies ReadonlyArray<BotCapabilityType>;

export function BotSettingsForm({
  bot,
  saving,
  onSave,
}: {
  bot: Bot;
  saving: boolean;
  onSave: (input: BotUpdateInput) => Promise<void>;
}) {
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const [description, setDescription] = useState(bot.description);
  const [modelSelection, setModelSelection] = useState(bot.modelSelection);
  const [chiefOfStaff, setChiefOfStaff] = useState(bot.chiefOfStaff);
  const [isolationMode, setIsolationMode] = useState(bot.isolationMode);
  const [autonomyEnabled, setAutonomyEnabled] = useState(bot.autonomy.enabled);
  const [capabilityGrants, setCapabilityGrants] = useState<ReadonlyArray<BotCapabilityType>>(
    bot.capabilityGrants,
  );
  const statuses = useProviderStatusesForLocalConfig();
  const catalog = useProviderModelCatalog({
    selectedProvider: modelSelection.provider,
    discoveryEnabled: true,
    modelHintByProvider: { [modelSelection.provider]: modelSelection.model },
  });
  const { settings } = useAppSettings();
  const dirty =
    name.trim() !== bot.name ||
    title.trim() !== bot.title ||
    description.trim() !== bot.description ||
    modelSelection.provider !== bot.modelSelection.provider ||
    modelSelection.model !== bot.modelSelection.model ||
    chiefOfStaff !== bot.chiefOfStaff ||
    isolationMode !== bot.isolationMode ||
    autonomyEnabled !== bot.autonomy.enabled ||
    capabilityGrants.join("|") !== bot.capabilityGrants.join("|");

  const capabilityLabels: Record<BotCapabilityType, string> = {
    "thread.read": "Read Vulcan threads",
    "thread.write": "Start and steer work",
    "automation.write": "Create or change automations",
    "browser.read": "Inspect browser pages",
    "browser.control": "Control the browser",
    "filesystem.read": "Read workspace files",
    "filesystem.write": "Change workspace files",
    "shell.execute": "Run shell commands",
    "network.external": "Contact external services",
    "peer.message": "Message other coworkers",
  };

  return (
    <section className="space-y-3">
      <div>
        <h2 className="font-heading text-base font-semibold">Settings</h2>
        <p className="text-xs text-muted-foreground">Identity and default model for new turns.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium">
          Name
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="space-y-1 text-xs font-medium">
          Role
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
      </div>
      <label className="block space-y-1 text-xs font-medium">
        About
        <Textarea value={description} onChange={(event) => setDescription(event.target.value)} />
      </label>
      <div className="space-y-1">
        <p className="text-xs font-medium">Model</p>
        <ProviderModelPicker
          provider={modelSelection.provider}
          model={modelSelection.model}
          lockedProvider={null}
          providers={[...statuses]}
          modelOptionsByProvider={catalog.modelOptionsByProvider}
          loadingModelProviders={catalog.loadingModelProviders}
          hiddenProviders={settings.hiddenProviders}
          providerOrder={settings.providerOrder}
          onProviderModelChange={(provider, model) => setModelSelection({ provider, model })}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={chiefOfStaff}
          onChange={(event) => setChiefOfStaff(event.target.checked)}
        />
        Chief of staff
      </label>
      <div className="grid gap-4 rounded-xl border border-border p-4 sm:grid-cols-2">
        <label className="space-y-1 text-xs font-medium">
          Isolation
          <select
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={isolationMode}
            onChange={(event) => setIsolationMode(event.target.value as Bot["isolationMode"])}
          >
            <option value="worktree">Managed Git worktree</option>
            <option value="workspace">Private bot workspace only</option>
          </select>
          <span className="block font-normal text-muted-foreground">
            Project tasks get a separate checkout; workspace-only bots cannot touch the shared
            project checkout.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            className="mt-1"
            type="checkbox"
            checked={autonomyEnabled}
            onChange={(event) => setAutonomyEnabled(event.target.checked)}
          />
          <span>
            Autonomous coworker
            <span className="block text-xs text-muted-foreground">
              Allows governed task runs. Capability grants still apply.
            </span>
          </span>
        </label>
      </div>
      <fieldset className="space-y-2 rounded-xl border border-border p-4">
        <legend className="px-1 text-xs font-medium">Capability grants</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {BOT_CAPABILITIES.map((capability) => (
            <label key={capability} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={capabilityGrants.includes(capability)}
                onChange={(event) =>
                  setCapabilityGrants((current) =>
                    event.target.checked
                      ? [...current, capability]
                      : current.filter((entry) => entry !== capability),
                  )
                }
              />
              {capabilityLabels[capability]}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="flex justify-end">
        <Button
          disabled={saving || !dirty || name.trim().length === 0}
          onClick={() =>
            void onSave({
              id: bot.id,
              name: name.trim(),
              title: title.trim(),
              description: description.trim(),
              modelSelection,
              chiefOfStaff,
              isolationMode,
              autonomy: { ...bot.autonomy, enabled: autonomyEnabled },
              capabilityGrants: [...capabilityGrants],
            })
          }
        >
          {saving ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </section>
  );
}
