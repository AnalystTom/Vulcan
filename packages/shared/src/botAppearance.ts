// FILE: botAppearance.ts
// Purpose: One table of what a bot's colour means, so a bot looks the same
// wherever it appears -- its avatar in the roster, and the lane it owns in a
// factory trace.
// Layer: shared domain logic
//
// The two surfaces are drawn by different processes and cannot share a
// stylesheet: the avatar is a Tailwind class in the browser, while the lane
// swatch is a hex string the server writes into `sssf.db` long before any UI
// reads it. Keeping both columns of the same table here is what stops a bot
// being teal on its profile and violet in the Factory pane.

import type { BotAvatar, BotColor } from "@vulcan/contracts";

/**
 * The swatch each bot colour resolves to, taken from the Tailwind hue the
 * avatar tints with (noted per row, so the two stay checkable by eye).
 */
export const BOT_COLOR_HEX: Record<BotColor, string> = {
  green: "#10b981", // emerald-500
  blue: "#3b82f6", // blue-500
  red: "#ef4444", // red-500
  orange: "#f97316", // orange-500
  purple: "#a855f7", // purple-500
  cyan: "#06b6d4", // cyan-500
  pink: "#ec4899", // pink-500
  yellow: "#eab308", // yellow-500
  teal: "#14b8a6", // teal-500
  coral: "#fb7185", // rose-400
};

/**
 * The avatar's surface and label per colour.
 *
 * Written out as whole class strings rather than composed from the hue, because
 * Tailwind only emits a class it can find literally in the source.
 */
export const BOT_AVATAR_COLOR_CLASS: Record<BotColor, string> = {
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

/**
 * A colour name's swatch, or null when it is not one of ours.
 *
 * Defensive because the caller may be holding a value read back out of a
 * database another process can write, where "purple" is a hope rather than a
 * guarantee.
 */
export const botColorHex = (color: string | null | undefined): string | null =>
  color !== null && color !== undefined && color in BOT_COLOR_HEX
    ? BOT_COLOR_HEX[color as BotColor]
    : null;

/** The swatch for a bot's avatar, for anything drawing it without a stylesheet. */
export const botAvatarHex = (avatar: BotAvatar): string | null => botColorHex(avatar.color);
