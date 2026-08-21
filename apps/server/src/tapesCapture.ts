// FILE: tapesCapture.ts
// Purpose: Keep the local Tapes integration at one server boundary.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface TapesProcessCommand {
  readonly command: string;
  readonly args: readonly string[];
}

interface TapesStartState {
  readonly api_url?: unknown;
}

export function isTapesCaptureEnabled(): boolean {
  return process.env.VULCAN_TAPES_CAPTURE?.trim().toLowerCase() === "on";
}

/**
 * Tapes' CLI wrapper is not a reliable transport for Codex JSON-RPC app-server
 * sessions. Keep Codex native so every startup path (session, fork, discovery)
 * remains available when the local Tapes daemon is unavailable.
 */
export function tapesCodexAppServerCommand(binaryPath: string): TapesProcessCommand {
  return { command: binaryPath, args: ["app-server"] };
}

export function tapesHarnessCommand(
  harness: "claude" | "codex" | "opencode",
  binaryPath: string,
  args: readonly string[],
  captureEnabled = isTapesCaptureEnabled(),
): TapesProcessCommand {
  if (!captureEnabled || binaryPath !== harness) {
    return { command: binaryPath, args };
  }
  return { command: "tapes", args: ["start", harness, "--", ...args] };
}

function isLoopbackTapesApi(url: URL): boolean {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1") &&
    url.username === "" &&
    url.password === ""
  );
}

/** The daemon advertises its dynamic, local-only read endpoint in start.json. */
export async function readLocalTapesApiUrl(): Promise<URL | null> {
  let parsed: TapesStartState;
  try {
    parsed = JSON.parse(
      await readFile(path.join(homedir(), ".tapes", "start.json"), "utf8"),
    ) as TapesStartState;
  } catch {
    return null;
  }
  if (typeof parsed.api_url !== "string") return null;
  try {
    const apiUrl = new URL(parsed.api_url);
    return isLoopbackTapesApi(apiUrl) ? apiUrl : null;
  } catch {
    return null;
  }
}
