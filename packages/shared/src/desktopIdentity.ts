// FILE: desktopIdentity.ts
// Purpose: Defines the canonical desktop application identity across packaging and runtime.

export const VULCAN_DESKTOP_SCHEME = "vulcan";
export const VULCAN_DESKTOP_ORIGIN = `${VULCAN_DESKTOP_SCHEME}://app`;
export const VULCAN_DESKTOP_ENTRY_URL = `${VULCAN_DESKTOP_ORIGIN}/index.html`;
export const VULCAN_DESKTOP_UPDATE_CHANNEL = "vulcan";
export const VULCAN_PRODUCTION_BUNDLE_ID = "com.vulcanapp.vulcan";
export const VULCAN_DEVELOPMENT_BUNDLE_ID = `${VULCAN_PRODUCTION_BUNDLE_ID}.dev`;
export const VULCAN_CANARY_BUNDLE_ID = `${VULCAN_PRODUCTION_BUNDLE_ID}.canary`;
export const VULCAN_CANARY_DESKTOP_SCHEME = "vulcan-canary";
export const VULCAN_CANARY_DESKTOP_ORIGIN = `${VULCAN_CANARY_DESKTOP_SCHEME}://app`;
export const VULCAN_CANARY_DESKTOP_ENTRY_URL = `${VULCAN_CANARY_DESKTOP_ORIGIN}/index.html`;

export type VulcanDesktopFlavor = "production" | "development" | "canary";

export interface VulcanDesktopIdentity {
  readonly flavor: VulcanDesktopFlavor;
  readonly displayName: string;
  readonly bundleId: string;
  readonly scheme: string;
  readonly origin: string;
  readonly entryUrl: string;
  readonly userDataDirectoryName: string;
  readonly defaultHomeDirectoryName: string;
  readonly usesScriptedUpdates: boolean;
}

export function resolveVulcanDesktopFlavor(input: {
  readonly isDevelopment: boolean;
  readonly requestedFlavor?: string | undefined;
}): VulcanDesktopFlavor {
  if (input.requestedFlavor?.trim().toLowerCase() === "canary") {
    return "canary";
  }
  return input.isDevelopment ? "development" : "production";
}

export function vulcanDesktopIdentity(flavor: VulcanDesktopFlavor): VulcanDesktopIdentity {
  if (flavor === "canary") {
    return {
      flavor,
      displayName: "Vulcan Canary",
      bundleId: VULCAN_CANARY_BUNDLE_ID,
      scheme: VULCAN_CANARY_DESKTOP_SCHEME,
      origin: VULCAN_CANARY_DESKTOP_ORIGIN,
      entryUrl: VULCAN_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "vulcan-canary",
      defaultHomeDirectoryName: ".vulcan-canary",
      usesScriptedUpdates: true,
    };
  }
  if (flavor === "development") {
    return {
      flavor,
      displayName: "Vulcan (Dev)",
      bundleId: VULCAN_DEVELOPMENT_BUNDLE_ID,
      scheme: VULCAN_DESKTOP_SCHEME,
      origin: VULCAN_DESKTOP_ORIGIN,
      entryUrl: VULCAN_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "vulcan-dev",
      defaultHomeDirectoryName: ".vulcan",
      usesScriptedUpdates: false,
    };
  }
  return {
    flavor,
    displayName: "Vulcan",
    bundleId: VULCAN_PRODUCTION_BUNDLE_ID,
    scheme: VULCAN_DESKTOP_SCHEME,
    origin: VULCAN_DESKTOP_ORIGIN,
    entryUrl: VULCAN_DESKTOP_ENTRY_URL,
    userDataDirectoryName: "vulcan",
    defaultHomeDirectoryName: ".vulcan",
    usesScriptedUpdates: false,
  };
}

export function vulcanBundleId(isDevelopment: boolean): string {
  return vulcanDesktopIdentity(isDevelopment ? "development" : "production").bundleId;
}
