import { describe, expect, it } from "vitest";

import {
  resolveVulcanDesktopFlavor,
  VULCAN_CANARY_BUNDLE_ID,
  VULCAN_CANARY_DESKTOP_ENTRY_URL,
  VULCAN_CANARY_DESKTOP_ORIGIN,
  VULCAN_DESKTOP_ENTRY_URL,
  VULCAN_DESKTOP_ORIGIN,
  VULCAN_DESKTOP_UPDATE_CHANNEL,
  VULCAN_DEVELOPMENT_BUNDLE_ID,
  VULCAN_PRODUCTION_BUNDLE_ID,
  vulcanBundleId,
  vulcanDesktopIdentity,
} from "./desktopIdentity";

describe("desktopIdentity", () => {
  it("uses the exact canonical production and development bundle IDs", () => {
    expect(VULCAN_PRODUCTION_BUNDLE_ID).toBe("com.vulcanapp.vulcan");
    expect(VULCAN_DEVELOPMENT_BUNDLE_ID).toBe("com.vulcanapp.vulcan.dev");
    expect(vulcanBundleId(false)).toBe(VULCAN_PRODUCTION_BUNDLE_ID);
    expect(vulcanBundleId(true)).toBe(VULCAN_DEVELOPMENT_BUNDLE_ID);
  });

  it("uses the exact packaged renderer origin and entry URL", () => {
    expect(VULCAN_DESKTOP_ORIGIN).toBe("vulcan://app");
    expect(VULCAN_DESKTOP_ENTRY_URL).toBe("vulcan://app/index.html");
  });

  it("uses the isolated Vulcan desktop update channel", () => {
    expect(VULCAN_DESKTOP_UPDATE_CHANNEL).toBe("vulcan");
  });

  it("gives Canary a fully separate desktop identity and storage profile", () => {
    expect(VULCAN_CANARY_BUNDLE_ID).toBe("com.vulcanapp.vulcan.canary");
    expect(VULCAN_CANARY_DESKTOP_ORIGIN).toBe("vulcan-canary://app");
    expect(VULCAN_CANARY_DESKTOP_ENTRY_URL).toBe("vulcan-canary://app/index.html");
    expect(vulcanDesktopIdentity("canary")).toEqual({
      flavor: "canary",
      displayName: "Vulcan Canary",
      bundleId: VULCAN_CANARY_BUNDLE_ID,
      scheme: "vulcan-canary",
      origin: VULCAN_CANARY_DESKTOP_ORIGIN,
      entryUrl: VULCAN_CANARY_DESKTOP_ENTRY_URL,
      userDataDirectoryName: "vulcan-canary",
      defaultHomeDirectoryName: ".vulcan-canary",
      usesScriptedUpdates: true,
    });
  });

  it("selects Canary explicitly without changing normal dev and production defaults", () => {
    expect(resolveVulcanDesktopFlavor({ isDevelopment: false })).toBe("production");
    expect(resolveVulcanDesktopFlavor({ isDevelopment: true })).toBe("development");
    expect(resolveVulcanDesktopFlavor({ isDevelopment: false, requestedFlavor: " canary " })).toBe(
      "canary",
    );
    expect(resolveVulcanDesktopFlavor({ isDevelopment: true, requestedFlavor: "canary" })).toBe(
      "canary",
    );
  });
});
