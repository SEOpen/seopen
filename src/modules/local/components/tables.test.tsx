import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BusinessesTable, type BusinessRow } from "./tables";

const row: BusinessRow = {
  id: 1,
  title: "Fernhill Bakery",
  address: null,
  grid: "5×5 · 5 mi",
  keywords: 1,
  avgRank: null,
  change: null,
  delta: null,
  top3: null,
  found: "–",
  lastChecked: null,
};

const lastCheck = (over: Partial<BusinessRow>) => renderToStaticMarkup(<BusinessesTable rows={[{ ...row, ...over }]} />);

describe("BusinessesTable last check", () => {
  it("says Not yet only when nothing has run", () => {
    expect(lastCheck({})).toContain("Not yet");
    expect(lastCheck({})).not.toContain("failed");
  });

  it("says a first check failed, not Not yet", () => {
    const html = lastCheck({ lastTry: "failed Nov 7" });
    expect(html).toContain("failed Nov 7");
    expect(html).not.toContain("Not yet");
  });

  it("says a stuck check didn't start, quietly", () => {
    const html = lastCheck({ lastTry: "didn't start Nov 7" });
    expect(html.replace(/&#x27;/g, "'")).toContain("didn't start Nov 7");
    expect(html).not.toContain("text-bad");
  });

  it("keeps the last good check and says a newer one failed", () => {
    const html = lastCheck({ lastChecked: "2026-11-05T10:00:00Z", lastTry: "failed Nov 7" });
    expect(html).toContain("newer check failed Nov 7");
    expect(html).toContain("Nov 5");
  });
});
