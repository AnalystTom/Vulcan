// FILE: BotAvatarPicker.tsx
// Purpose: One picker for how a bot looks — expression + colour swatch, with a live
//          preview of the avatar the rest of the app draws.
// Layer: Web UI component
// Exports: BotAvatarPicker
// Why: The create dialog and the settings Appearance card must offer the same choices
//      in the same order; a second inline swatch list is how they drift apart.

import { BotAvatarShape, BotColor, type BotAvatar as BotAvatarData } from "@vulcan/contracts";
import { BOT_COLOR_HEX } from "@vulcan/shared/botAppearance";

import { BotAvatar } from "~/components/bots/BotAvatar";
import { Button } from "~/components/ui/button";
import { resolveBotAvatarShape } from "~/lib/botDefaults";
import { cn } from "~/lib/utils";

// Straight off the contract, so a colour or expression added there shows up here without
// a second list to remember to update.
const AVATAR_SHAPES = BotAvatarShape.literals;
const AVATAR_COLORS = BotColor.literals;

const SHAPE_LABEL: Record<BotAvatarShape, string> = {
  idle: "Idle",
  happy: "Happy",
  curious: "Curious",
  drowsy: "Drowsy",
  working: "Working",
  thinking: "Thinking",
  listening: "Listening",
  sleeping: "Sleeping",
  suspicious: "Suspicious",
  proud: "Proud",
};

const SECTION_LABEL_CLASS =
  "text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground";

export function BotAvatarPicker({
  avatar,
  name,
  onChange,
  onReset,
  className,
}: {
  avatar: BotAvatarData;
  /** Drives the preview's initials; the bot may not be named yet. */
  name: string;
  onChange: (avatar: BotAvatarData) => void;
  /** Rendered as "Reset to default" when supplied. */
  onReset?: () => void;
  className?: string;
}) {
  const previewName = name.trim() || "New agent";
  const shape = resolveBotAvatarShape(avatar);

  return (
    <div className={cn("space-y-4", className)}>
      <div className="flex items-center gap-3">
        <BotAvatar avatar={avatar} name={previewName} className="size-12 text-base" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{previewName}</p>
          <p className="text-xs capitalize text-muted-foreground">
            {shape} · {avatar.color}
          </p>
        </div>
        {onReset ? (
          <Button className="ml-auto" variant="ghost" size="sm" type="button" onClick={onReset}>
            Reset to default
          </Button>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <p className={SECTION_LABEL_CLASS}>Expression</p>
        <div className="grid grid-cols-5 gap-2">
          {AVATAR_SHAPES.map((value) => (
            <button
              key={value}
              type="button"
              title={SHAPE_LABEL[value]}
              aria-label={`Use the ${SHAPE_LABEL[value].toLowerCase()} expression`}
              aria-pressed={shape === value}
              className="flex flex-col items-center gap-1 rounded-xl border border-transparent bg-muted/40 px-1 py-2 transition-colors hover:bg-muted aria-pressed:border-foreground/30 aria-pressed:bg-muted"
              onClick={() => onChange({ ...avatar, kind: "shape", shape: value })}
            >
              <BotAvatar
                avatar={{ ...avatar, kind: "shape", shape: value }}
                name={previewName}
                className="size-8 text-[11px]"
              />
              <span className="w-full truncate text-center text-[10px] text-muted-foreground">
                {SHAPE_LABEL[value]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <p className={SECTION_LABEL_CLASS}>Color</p>
        <div className="flex flex-wrap gap-2">
          {AVATAR_COLORS.map((value) => (
            <button
              key={value}
              type="button"
              title={value}
              aria-label={`Use the ${value} avatar color`}
              aria-pressed={avatar.color === value}
              className="size-7 rounded-full ring-offset-2 ring-offset-background transition-transform hover:scale-110 aria-pressed:ring-2 aria-pressed:ring-foreground/60"
              style={{ backgroundColor: BOT_COLOR_HEX[value] }}
              onClick={() => onChange({ ...avatar, color: value })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
