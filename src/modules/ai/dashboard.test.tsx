import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dashboard } from "./dashboard";
import { fixtures } from "./dashboard.fixtures";

// The loader imports server-only code; only the pure parts run here.
vi.mock("server-only", () => ({}));

const card = (data: typeof fixtures.full) =>
  renderToStaticMarkup(<dashboard.View data={data} />)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");

describe("AI visibility card", () => {
  it("says beside the count how many answers failed, as /ai does", () => {
    const text = card({ ...fixtures.full, failed: 3 });
    expect(text).toContain("12 of 40");
    expect(text).toContain("3 failed");
  });

  it("says nothing about failures when there are none", () => {
    expect(card({ ...fixtures.full, failed: 0 })).not.toContain("failed");
  });
});
