import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import {
  acknowledgeVulcanStorageSnapshot,
  readVulcanStorageSnapshot,
  saveVulcanStorageSnapshot,
  VULCAN_STORAGE_SNAPSHOT_MAX_BYTES,
  validateVulcanStorageSnapshot,
} from "./desktopStorageMigration";

const snapshot = (exportedAt = "2026-07-09T00:00:00.000Z") => ({
  version: 1 as const,
  exportedAt,
  entries: {
    "vulcan:theme": "dark",
    "vulcan.openUsage.enabled": "true",
  },
});

describe("desktopStorageMigration", () => {
  it("round-trips atomically and acknowledges the snapshot", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "vulcan-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await expect(saveVulcanStorageSnapshot(target, snapshot())).resolves.toBe(true);
      expect(readVulcanStorageSnapshot(target)).toEqual(snapshot());
      expect(FS.readdirSync(directory)).toEqual(["snapshot.json"]);

      await acknowledgeVulcanStorageSnapshot(target);
      expect(readVulcanStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed, disallowed, and oversized snapshots", () => {
    expect(validateVulcanStorageSnapshot({ version: 1 })).toBeNull();
    expect(
      validateVulcanStorageSnapshot({
        ...snapshot(),
        entries: { "foreign:theme": "dark" },
      }),
    ).toBeNull();
    expect(
      validateVulcanStorageSnapshot({
        ...snapshot(),
        entries: { "vulcan:large": "x".repeat(VULCAN_STORAGE_SNAPSHOT_MAX_BYTES) },
      }),
    ).toBeNull();
  });

  it("accepts renderer snapshots containing large composer drafts", () => {
    const largeDraft = "x".repeat(2 * 1024 * 1024);

    expect(
      validateVulcanStorageSnapshot({
        ...snapshot(),
        entries: { "vulcan:composer-drafts:v1": largeDraft },
      })?.entries["vulcan:composer-drafts:v1"],
    ).toBe(largeDraft);
  });

  it("does not replace a newer snapshot with an older export", async () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "vulcan-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      await saveVulcanStorageSnapshot(target, snapshot("2026-07-09T01:00:00.000Z"));
      await expect(
        saveVulcanStorageSnapshot(target, snapshot("2026-07-09T00:00:00.000Z")),
      ).resolves.toBe(false);
      expect(readVulcanStorageSnapshot(target)?.exportedAt).toBe("2026-07-09T01:00:00.000Z");
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats missing and malformed files as absent", () => {
    const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "vulcan-storage-migration-"));
    const target = Path.join(directory, "snapshot.json");
    try {
      expect(readVulcanStorageSnapshot(target)).toBeNull();
      FS.writeFileSync(target, "not json");
      expect(readVulcanStorageSnapshot(target)).toBeNull();
    } finally {
      FS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
