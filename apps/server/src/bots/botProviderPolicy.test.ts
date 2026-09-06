import { describe, expect, it } from "vitest";

import { requiredBotCapabilitiesForProviderRequest } from "./botProviderPolicy.ts";

describe("requiredBotCapabilitiesForProviderRequest", () => {
  it("separates native shell, file read, file write, and network authority", () => {
    expect(requiredBotCapabilitiesForProviderRequest("exec_command_approval")).toEqual([
      "shell.execute",
    ]);
    expect(requiredBotCapabilitiesForProviderRequest("file_read_approval")).toEqual([
      "filesystem.read",
    ]);
    expect(requiredBotCapabilitiesForProviderRequest("apply_patch_approval")).toEqual([
      "filesystem.write",
    ]);
    expect(requiredBotCapabilitiesForProviderRequest("auth_tokens_refresh")).toEqual([
      "network.external",
    ]);
  });

  it("fails broad and unknown permission requests closed", () => {
    expect(requiredBotCapabilitiesForProviderRequest("permissions_approval")).toEqual([
      "shell.execute",
      "filesystem.write",
      "network.external",
    ]);
    expect(requiredBotCapabilitiesForProviderRequest("unknown")).toHaveLength(3);
  });
});
