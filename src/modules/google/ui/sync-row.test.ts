import { describe, expect, it } from "vitest";
import { syncMessage, syncThrough } from "./sync-row";

describe("syncMessage", () => {
  it("doesn't repeat what the badge beside it says", () => {
    expect(syncMessage("ok", "Up to date")).toBeNull();
  });

  it("keeps a message that adds something", () => {
    expect(syncMessage("ok", "Backfill continues from 2025-07-01")).toBe("Backfill continues from 2025-07-01");
    expect(syncMessage("ok", "No final data in Search Console yet")).toBe("No final data in Search Console yet");
    expect(syncMessage("error", null)).toBeNull();
  });
});

describe("syncThrough", () => {
  it("says the sync checked up to that day, which isn't the same as data for it", () => {
    expect(syncThrough("2026-11-05")).toBe("Checked through Nov 5, 2026");
  });
});
