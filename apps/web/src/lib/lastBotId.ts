// FILE: lastBotId.ts
// Purpose: Remember the last bot opened for OpenBot-style Bots segment restore.
// Layer: Web helper
// Exports: readLastBotId, writeLastBotId

import type { BotId } from "@vulcan/contracts";

const STORAGE_KEY = "vulcan.lastBotId";

export function readLastBotId(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeLastBotId(botId: BotId | string): void {
  try {
    localStorage.setItem(STORAGE_KEY, botId);
  } catch {
    // Ignore quota / private-mode failures; restore just falls back to first bot.
  }
}
