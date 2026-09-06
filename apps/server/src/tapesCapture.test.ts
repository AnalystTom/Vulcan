import { afterEach, describe, expect, it } from "vitest";

import { tapesCodexAppServerCommand, tapesHarnessCommand } from "./tapesCapture";

const originalCaptureSetting = process.env.VULCAN_TAPES_CAPTURE;

afterEach(() => {
  if (originalCaptureSetting === undefined) {
    delete process.env.VULCAN_TAPES_CAPTURE;
  } else {
    process.env.VULCAN_TAPES_CAPTURE = originalCaptureSetting;
  }
});

describe("tapesHarnessCommand", () => {
  it("starts Codex directly by default so an unavailable Tapes daemon cannot block session startup", () => {
    delete process.env.VULCAN_TAPES_CAPTURE;

    expect(tapesCodexAppServerCommand("codex")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("keeps Codex native even when generic Tapes capture is explicitly enabled", () => {
    process.env.VULCAN_TAPES_CAPTURE = "on";

    expect(tapesCodexAppServerCommand("codex")).toEqual({
      command: "codex",
      args: ["app-server"],
    });
  });

  it("bypasses Tapes for custom binaries even when capture is explicitly enabled", () => {
    process.env.VULCAN_TAPES_CAPTURE = "on";

    expect(tapesHarnessCommand("codex", "/custom/codex", ["app-server"])).toEqual({
      command: "/custom/codex",
      args: ["app-server"],
    });
  });
});
