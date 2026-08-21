import type { BotAvatar as BotAvatarData } from "@vulcan/contracts";

import { cn } from "~/lib/utils";

const COLOR_CLASS: Record<BotAvatarData["color"], string> = {
  green: "bg-emerald-500/18 text-emerald-600 dark:text-emerald-300",
  blue: "bg-blue-500/18 text-blue-600 dark:text-blue-300",
  red: "bg-red-500/18 text-red-600 dark:text-red-300",
  orange: "bg-orange-500/18 text-orange-600 dark:text-orange-300",
  purple: "bg-purple-500/18 text-purple-600 dark:text-purple-300",
  cyan: "bg-cyan-500/18 text-cyan-600 dark:text-cyan-300",
  pink: "bg-pink-500/18 text-pink-600 dark:text-pink-300",
  yellow: "bg-yellow-500/18 text-yellow-700 dark:text-yellow-300",
  teal: "bg-teal-500/18 text-teal-600 dark:text-teal-300",
  coral: "bg-rose-400/18 text-rose-600 dark:text-rose-300",
};

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
        COLOR_CLASS[avatar.color],
        className,
      )}
      title={avatar.kind === "shape" ? avatar.shape : "Uploaded avatar"}
    >
      {initials || "B"}
    </div>
  );
}
