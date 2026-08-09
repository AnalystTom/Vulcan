// FILE: vulcanHome.ts
// Purpose: Resolves the user-level Vulcan base directory without Effect, so the backend
// server and the Electron main process agree on one location during early startup.
// Exports: expandHomePath, resolveVulcanHomeDirectory, VULCAN_HOME_ENV_NAME.

import * as OS from "node:os";
import * as Path from "node:path";

export const VULCAN_HOME_ENV_NAME = "VULCAN_HOME";
export const DEFAULT_VULCAN_HOME_DIRECTORY_NAME = ".vulcan";

/** Expands a leading `~` against the user's home directory; other inputs pass through. */
export function expandHomePath(input: string, homeDirectory: string = OS.homedir()): string {
  if (input === "~") {
    return homeDirectory;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return Path.join(homeDirectory, input.slice(2));
  }
  return input;
}

/**
 * Resolves the Vulcan base directory the same way for every process in the install.
 *
 * Deliberately plain Node: the Electron main process needs this before Effect (or even
 * `app.whenReady()`) is available, and the login-shell environment cache has to land in
 * the same place whichever process wrote it first.
 */
export function resolveVulcanHomeDirectory(
  options: {
    /** Explicit override; falls back to `VULCAN_HOME` from `env`. */
    readonly configuredHome?: string | undefined;
    readonly env?: NodeJS.ProcessEnv;
    readonly homeDirectory?: string;
    /** Flavor-specific default (`.vulcan-canary`), used only when nothing is configured. */
    readonly directoryName?: string;
  } = {},
): string {
  const homeDirectory = options.homeDirectory ?? OS.homedir();
  const configured = (
    options.configuredHome ?? (options.env ?? process.env)[VULCAN_HOME_ENV_NAME]
  )?.trim();
  if (!configured) {
    return Path.join(homeDirectory, options.directoryName ?? DEFAULT_VULCAN_HOME_DIRECTORY_NAME);
  }
  return Path.resolve(expandHomePath(configured, homeDirectory));
}
