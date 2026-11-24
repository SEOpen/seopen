import { describe, expect, it } from "vitest";
import { APPLY_LABEL, FIX_TABS, fixesFigures, fixesSentence } from "./brief";

const counts = (over: Partial<Record<"open" | "applied" | "live" | "measured" | "resolved" | "dismissed", number>> = {}) => ({ open: 0, applied: 0, live: 0, measured: 0, resolved: 0, dismissed: 0, ...over });

describe("fixesSentence", () => {
  it("leads with a measured result", () => {
    expect(fixesSentence("x.com", counts({ open: 3 }), 2, "Fixed 2 titles on Nov 18. Clicks up 18% in 14 days.")).toBe("Fixed 2 titles on Nov 18. Clicks up 18% in 14 days.");
  });

  it("counts what's to do, and what the code can settle", () => {
    expect(fixesSentence("x.com", counts({ open: 1 }), 1, null)).toBe("1 thing is worth fixing on x.com. It can be changed in the code.");
    expect(fixesSentence("x.com", counts({ open: 5, applied: 1 }), 3, null)).toBe("5 things are worth fixing on x.com. 3 can be changed in the code. 1 change is being checked.");
    expect(fixesSentence("x.com", counts({ open: 2 }), 0, null)).toBe("2 things are worth fixing on x.com.");
  });

  it("gives a calm answer when there's nothing to do", () => {
    expect(fixesSentence("x.com", counts({ live: 2 }), 0, null)).toBe("Nothing new to fix on x.com, and 2 changes are being checked.");
    expect(fixesSentence("x.com", counts({ measured: 2 }), 0, null)).toBe("Nothing to fix on x.com right now.");
    expect(fixesSentence("x.com", counts(), 0, null)).toContain("site audit");
  });
});

describe("the Fixes page's states", () => {
  it("names each figure as its tab, and counts the same fixes", () => {
    const c = counts({ open: 4, applied: 1, live: 2, measured: 3, resolved: 5, dismissed: 6 });
    const figures = fixesFigures(c, 2);
    for (const f of figures) {
      const tab = FIX_TABS.find((t) => t.label === f.label);
      expect(tab, f.label).toBeDefined();
      expect(f.value).toBe(String(tab!.statuses.reduce((n, s) => n + c[s], 0)));
    }
    expect(figures.map((f) => f.label)).toEqual(["To fix", "Being checked", "Done"]);
    expect(figures[2]).toMatchObject({ value: "8", href: "/fixes?status=done" });
  });

  it("doesn't call marking a change done, since it moves the fix to Being checked", () => {
    expect(APPLY_LABEL).not.toMatch(/done/i);
    expect(FIX_TABS.find((t) => t.statuses.includes("applied"))?.label).toBe("Being checked");
  });
});
