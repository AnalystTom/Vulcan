import type { BotAvatar as BotAvatarData } from "@vulcan/contracts";
import { BOT_AVATAR_COLOR_CLASS } from "@vulcan/shared/botAppearance";

import { cn } from "~/lib/utils";

export function BotAvatar({
  avatar,
  name,
  className,
}: {
  avatar: BotAvatarData;
  name: string;
  className?: string;
}) {
  const initials = name
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  return (
    <div
      aria-label={`${name} avatar`}
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-[42%] font-display text-sm font-semibold",
        BOT_AVATAR_COLOR_CLASS[avatar.color],
        className,
      )}
      title={avatar.kind === "shape" ? avatar.shape : "Uploaded avatar"}
    >
      {initials || "B"}
    </div>
  );
}
