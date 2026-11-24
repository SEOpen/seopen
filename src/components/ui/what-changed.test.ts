import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DASHBOARD_MODULES } from "@/app/(app)/dashboard-modules";
import * as ai from "@/modules/ai/dashboard.fixtures";
import * as audit from "@/modules/audit/dashboard.fixtures";
import * as backlinks from "@/modules/backlinks/dashboard.fixtures";
import * as domains from "@/modules/domains/dashboard.fixtures";
import * as google from "@/modules/google/dashboard.fixtures";
import * as ga4 from "@/modules/google/ga4-dashboard.fixtures";
import * as local from "@/modules/local/dashboard.fixtures";
import * as rank from "@/modules/rank/dashboard.fixtures";
import { compare, shownChange, type AnyDashboardModule, type KpiChange } from "./module-card";
import { changeWeight, deltaBetween, foldRows, pickHighlights, rowMeta, WhatChanged, type ChangeRow } from "./what-changed";

// The real modules' loaders import server-only code; only their pure baseline/changes run here.
vi.mock("server-only", () => ({}));

function fake(id: string, baseline: string | null, changes: (KpiChange | null)[]): AnyDashboardModule {
  return { id, label: id, href: `/${id}`, setup: { text: "", href: "" }, load: async () => null, describe: () => "", baseline: () => baseline, changes: () => changes, View: () => null };
}

describe("foldRows", () => {
  it("shows the standing rows then the biggest moves, and folds the rest in order", () => {
    expect(foldRows([1, 2, 3, 4], [5, 6, 7, 8])).toEqual({ shown: [1, 2, 3, 4, 5], folded: [6, 7, 8] });
  });

  it("folds nothing at five or fewer", () => {
    expect(foldRows([1, 2, 3, 4], [5])).toEqual({ shown: [1, 2, 3, 4, 5], folded: [] });
    expect(foldRows([])).toEqual({ shown: [], folded: [] });
  });
});

describe("WhatChanged", () => {
  const row = (n: number): ChangeRow => ({ key: `k${n}`, label: `Row ${n}`, source: "Module", href: "/m", state: "value", to: String(n), delta: null });
  const render = (count: number) => renderToStaticMarkup(createElement(WhatChanged, { rows: Array.from({ length: count }, (_, i) => row(i + 1)) }));

  it("folds past five rows behind a disclosure, keeping every row in the page", () => {
    const html = render(8);
    expect(html).toContain("<details");
    expect(html).toContain("All 8");
    for (let n = 1; n <= 8; n++) expect(html).toContain(`Row ${n}<`);
    expect(html.indexOf("Row 5<")).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("Row 6<"));
  });

  it("has nothing to disclose at five", () => {
    expect(render(5)).not.toContain("<details");
  });
});

describe("changeWeight", () => {
  it("measures counts relative to where they started, damping tiny moves", () => {
    expect(changeWeight({ from: 13, to: 26, unit: "percent" })).toBe(1);
    expect(changeWeight({ from: 1000, to: 600, unit: "number" })).toBeCloseTo(0.4);
    // One keyword into the top 3 shouldn't outrank a 40% traffic drop.
    expect(changeWeight({ from: 1, to: 2, unit: "number" })).toBeLessThan(0.4);
  });

  it("gives ratios a 5% floor so tiny rates don't read as huge", () => {
    expect(changeWeight({ from: 0.001, to: 0.002, unit: "points" })).toBeCloseTo(0.02);
    expect(changeWeight({ from: 0.2, to: 0.25, unit: "points" })).toBeCloseTo(0.25);
  });
});

describe("pickHighlights", () => {
  it("splits worse from better by goodWhen, biggest first, and keeps the baseline", () => {
    const { comparable, worse, better } = pickHighlights([
      {
        module: fake("gsc", "previous 28 days", [
          compare("Clicks", 26, 13, { unit: "percent" }),
          compare("Impressions", 20625, 22968, { unit: "percent" }),
          compare("Tracked position", 12.9, 17.9, { unit: "decimal", goodWhen: "down", format: (n) => n.toFixed(1), rank: true }),
        ]),
        data: null,
      },
      { module: fake("audit", "previous crawl", [compare("Errors", 40, 10, { goodWhen: "down" })]), data: null },
    ]);
    expect(comparable).toBe(true);
    expect(worse.map((h) => h.label)).toEqual(["Errors", "Impressions"]);
    expect(worse[0]).toMatchObject({ up: true, amount: "30", from: "10", to: "40", baseline: "previous crawl", tone: "bad" });
    expect(better.map((h) => h.label)).toEqual(["Clicks", "Tracked position"]);
    // A position that fell is better: the arrow points up and the words say so.
    expect(better[1]).toMatchObject({ up: true, verb: "improved", amount: "5 places", signed: "−5", from: "17.9", to: "12.9" });
    expect(worse[1]).toMatchObject({ verb: "down", amount: "10%", signed: "−10%" });
  });

  it("words a small count as the plain difference, and money as a percentage", () => {
    const { better } = pickHighlights([
      {
        module: fake("gsc", "previous 28 days", [compare("Clicks", 37, 14, { unit: "percent" }), compare("Revenue", 40, 20, { unit: "percent", money: true })]),
        data: null,
      },
    ]);
    expect(better.find((h) => h.label === "Clicks")).toMatchObject({ amount: "23", signed: "+23", short: "+23" });
    expect(better.find((h) => h.label === "Revenue")).toMatchObject({ amount: "100%", signed: "+100%" });
  });

  describe("reads a count the same as the figure on its card", () => {
    const of = (id: string) => DASHBOARD_MODULES.find((m) => m.id === id)!;
    const highlights = (id: string, data: unknown) => {
      const { worse, better } = pickHighlights([{ module: of(id), data }]);
      return Object.fromEntries([...worse, ...better].map((h) => [h.label, h.signed]));
    };
    const shown = (id: string, data: unknown) => renderToStaticMarkup(createElement(of(id).View, { data }));

    it("in Rankings", () => {
      const { latest, previous } = rank.fixtures.full;
      const data = { ...rank.fixtures.full, series: [], latest: { ...latest, top3: 80 }, previous: { ...previous!, top3: 60 } };
      expect(highlights("rank", data)["Top 3"]).toBe("+33%");
      expect(shown("rank", data)).toContain("33%");
    });

    it("in Site audit, as the MCP text is", () => {
      const { latest } = audit.fixtures.full;
      const data = { ...audit.fixtures.full, latest: { ...latest!, errors: 900, warnings: 1500, notices: 40 }, changes: { ...audit.fixtures.full.changes!, errors: -100, warnings: 300, notices: 20 } };
      expect(highlights("audit", data)).toMatchObject({ Errors: "−10%", Warnings: "+25%", Notices: "+20" });
      expect(shown("audit", data)).toContain("10%");
    });

    it("in Domain analysis", () => {
      const { latest, previous } = domains.fixtures.full;
      const data = { ...domains.fixtures.full, history: [], latest: { ...latest, keywords: 1200, traffic: 30, top10: 80 }, previous: { ...previous!, keywords: 1000, traffic: 10, top10: 60 } };
      expect(highlights("domains", data)).toMatchObject({ Keywords: "+20%", "Est. traffic": "+20", "Top 10": "+33%" });
    });

    it("keeps a count that starts from zero, on the row and the card", () => {
      const { latest, previous } = domains.fixtures.full;
      const data = { ...domains.fixtures.full, history: [], latest: { ...latest, keywords: 60 }, previous: { ...previous!, keywords: 0 } };
      expect(highlights("domains", data).Keywords).toBe("+60");
      expect(shown("domains", data)).toContain("60</span>");
      expect(shown("domains", data)).toContain("up ");
      const ranks = { ...rank.fixtures.full, series: [], latest: { ...rank.fixtures.full.latest, top3: 60 }, previous: { ...rank.fixtures.full.previous!, top3: 0 } };
      expect(highlights("rank", ranks)["Top 3"]).toBe("+60");
      expect(shown("rank", ranks)).toContain("up ");
    });

    it("names the earlier crawl's page count in Site audit when the crawl covered a different number", () => {
      const { latest } = audit.fixtures.full;
      const data = { ...audit.fixtures.full, latest: { ...latest!, pages: 49, notices: 98 }, changes: { ...audit.fixtures.full.changes!, notices: 42, pages: 21 } };
      const { worse } = pickHighlights([{ module: of("audit"), data }]);
      expect(worse.find((h) => h.label === "Notices")).toMatchObject({ from: "56", to: "98", baseline: "previous crawl of 28 pages" });
      expect(of("audit").baseline!({ ...data, changes: { ...data.changes, pages: 0 } })).toBe("previous crawl");
    });

    it("doesn't hide a few errors, or errors from none", () => {
      const { latest } = audit.fixtures.full;
      const data = { ...audit.fixtures.full, latest: { ...latest!, errors: 5, warnings: 0, notices: 0 }, changes: { ...audit.fixtures.full.changes!, errors: 5, warnings: 0, notices: 0 } };
      expect(highlights("audit", data).Errors).toBe("+5");
    });
  });

  it("skips moves that rest on too little data", () => {
    const { worse, better } = pickHighlights([
      {
        module: fake("gsc", "previous 28 days", [
          compare("Impressions", 6, 10, { unit: "percent" }),
          compare("Tracked position", 9, 18, { unit: "decimal", goodWhen: "down", rank: true, volume: 40 }),
          compare("CTR", 0.06, 0.03, { unit: "points", volume: 500 }),
        ]),
        data: null,
      },
    ]);
    expect([...worse, ...better].map((h) => h.label)).toEqual(["CTR"]);
  });

  it("drops small moves, no-direction metrics and cards with nothing earlier", () => {
    const r = pickHighlights([
      { module: fake("a", "Oct 20, 2026", [compare("Keywords", 1010, 1000), compare("Share", 0.5, 0.2, { unit: "points", goodWhen: "neither" })]), data: null },
      { module: fake("b", null, [compare("Clicks", 50, 10)]), data: null },
    ]);
    expect(r).toEqual({ comparable: true, worse: [], better: [] });
    expect(pickHighlights([{ module: fake("b", null, [null]), data: null }]).comparable).toBe(false);
  });
});

describe("deltaBetween", () => {
  it("is null when either reading is missing", () => {
    expect(deltaBetween(null, 3, "number")).toBeNull();
    expect(deltaBetween(3, undefined, "number")).toBeNull();
  });

  it("follows the number, and says better or worse for a position", () => {
    expect(deltaBetween(0.2, 0.15, "points")).toEqual({ text: "+5 pts", tone: "good", up: true });
    expect(deltaBetween(8, 12, "number", "down")).toEqual({ text: "−4", tone: "good", up: false });
    expect(deltaBetween(11.2, 14.6, "decimal", "down", true)).toEqual({ text: "3.4 better", tone: "good", up: true });
    expect(deltaBetween(14.6, 11.2, "decimal", "down", true)).toEqual({ text: "3.4 worse", tone: "bad", up: false });
    expect(deltaBetween(5, 5, "number")).toEqual({ text: "No change", tone: "muted", up: null });
  });
});

describe("rowMeta", () => {
  it("says the source and what the row covers", () => {
    expect(rowMeta({ label: "Errors", source: "Site audit", meta: "vs previous crawl" })).toBe("Site audit · vs previous crawl");
    expect(rowMeta({ label: "Errors", source: "Site audit" })).toBe("Site audit");
  });

  it("doesn't say the source twice when the label is the module's name", () => {
    expect(rowMeta({ label: "AI visibility", source: "AI visibility", meta: "vs previous run" })).toBe("vs previous run");
    expect(rowMeta({ label: "AI visibility", source: "AI visibility" })).toBe("");
  });
});

describe("module cards", () => {
  const card = (id: string, data: unknown) => {
    const m = DASHBOARD_MODULES.find((x) => x.id === id)!;
    return renderToStaticMarkup(createElement(m.View, { data }))
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ");
  };

  it("reads a better position as better, with the arrow up, like the rail", () => {
    expect(card("google", { ...google.fixtures.full, current: { ...google.fixtures.full.current, impressions: 100, position: 10 }, previous: { ...google.fixtures.full.previous!, impressions: 100, position: 13.4 } })).toContain("Search Console position 10.0 up 3.4 better (better)");
    expect(card("local", local.fixtures.full)).toContain("Avg. map rank 4.2 up 0.9 better (better)");
  });

  it("reads a worse position as worse, with the arrow down", () => {
    const { current, previous } = google.fixtures.full;
    expect(card("google", { ...google.fixtures.full, current: { ...current, impressions: 100, position: 18 }, previous: { ...previous!, impressions: 100, position: 15 } })).toContain("Search Console position 18.0 down 3 worse (worse)");
  });

  it("leaves out what the readout strip already shows, and keeps its change for What changed", () => {
    const changes = (id: string, data: unknown) => DASHBOARD_MODULES.find((x) => x.id === id)!.changes!(data).flatMap((c) => (c ? [c.label] : []));
    expect(card("google", google.fixtures.full)).not.toContain("Clicks");
    expect(changes("google", google.fixtures.full)).toContain("Clicks");
    expect(card("rank", rank.fixtures.full)).not.toMatch(/Top 10|On page one|Tracked position/);
    expect(changes("rank", rank.fixtures.full)).toEqual(expect.arrayContaining(["On page one", "Tracked position"]));
    expect(card("audit", audit.fixtures.full)).not.toContain("Health score");
    expect(changes("audit", audit.fixtures.full)).toContain("Health score");
    expect(card("ai", ai.fixtures.full)).not.toContain("Cited");
  });

  it("gives Local SEO's shares as points out of the total, as its page does", () => {
    const html = card("local", local.fixtures.full);
    expect(html).toContain("Top 3 45 of 125");
    expect(html).toContain("Points found 103 of 125");
    const [, top3] = DASHBOARD_MODULES.find((x) => x.id === "local")!.changes!(local.fixtures.full);
    expect([top3!.label, top3!.format(top3!.from), top3!.format(top3!.to)]).toEqual(["Top 3", "35 of 125", "45 of 125"]);
  });

  it("changes Local SEO's Top 3 in the unit its page does: points of the grid on the same grid, else percentage points", () => {
    const html = card("local", local.fixtures.full);
    expect(html).toContain("Top 3 45 of 125 up 10 (better)");
    expect(html).toContain("Points found 103 of 125 up 5 (better)");
    const [, top3] = DASHBOARD_MODULES.find((x) => x.id === "local")!.changes!(local.fixtures.full);
    expect(shownChange(top3!)).toEqual({ value: 10, unit: "number" });
    // A grid that grew can't compare counts, so it compares shares, as the page does.
    const grown = { ...local.fixtures.full, latest: { ...local.fixtures.full.latest, answered: 150 } };
    expect(card("local", grown)).toContain("Top 3 54 of 150 up 8 pts (better)");
    const [, shares] = DASHBOARD_MODULES.find((x) => x.id === "local")!.changes!(grown);
    expect(shownChange(shares!).unit).toBe("points");
  });

  it("calls followed links that, not dofollow", () => {
    expect(card("backlinks", backlinks.fixtures.full)).toContain("Followed links");
    expect(card("backlinks", backlinks.fixtures.full)).not.toContain("Dofollow");
  });

  it("shows small counts as a plain difference, and larger ones as a percentage", () => {
    const { current: gsc, previous: gscBefore } = google.fixtures.full;
    const small = card("google", { ...google.fixtures.full, current: { ...gsc, impressions: 8 }, previous: { ...gscBefore!, impressions: 4 } });
    expect(small).toContain("Impressions 8 up 4 (better)");
    expect(card("google", { ...google.fixtures.full, current: { ...gsc, impressions: 600 }, previous: { ...gscBefore!, impressions: 1000 } })).toContain("Impressions 600 down 40% (worse)");
    const { current: sessions, previous: sessionsBefore } = ga4.fixtures.full;
    const analytics = card("ga4", { ...ga4.fixtures.full, current: { ...sessions, sessions: 3, keyEvents: 1 }, previous: { ...sessionsBefore!, sessions: 5, keyEvents: 3 } });
    expect(analytics).toContain("Organic sessions 3 down 2 (worse)");
    expect(analytics).toContain("Key events 1 down 2 (worse)");
  });

  it("keeps revenue a percentage at any size", () => {
    const { current, previous } = ga4.fixtures.full;
    expect(card("ga4", { ...ga4.fixtures.full, current: { ...current, totalRevenue: 15 }, previous: { ...previous!, totalRevenue: 10 } })).toContain("Revenue $15 up 50% (better)");
  });

  it("shows no change with nothing earlier", () => {
    expect(card("google", google.fixtures.sparse)).not.toMatch(/better|worse/);
    expect(card("rank", rank.fixtures.sparse)).not.toMatch(/better|worse/);
  });

  it("names where a position or visibility comes from, in the card and in What changed", () => {
    const labels = (id: string, data: unknown) =>
      DASHBOARD_MODULES.find((x) => x.id === id)!
        .changes!(data)
        .flatMap((c) => (c ? [c.label] : []));
    expect(labels("google", google.fixtures.full)).toContain("Search Console position");
    expect(labels("rank", rank.fixtures.full)).toEqual(expect.arrayContaining(["Tracked position", "Visibility"]));
    expect(labels("ai", ai.fixtures.full)).toEqual(["AI visibility"]);
    expect(card("rank", rank.fixtures.full)).toContain("Visibility");
    expect(card("ai", ai.fixtures.full)).toContain("AI visibility");
    for (const [id, f] of [["google", google.fixtures.full], ["rank", rank.fixtures.full]] as const) expect(card(id, f)).not.toContain("Avg. position");
  });

  it("gives AI visibility one decimal, like its change", () => {
    expect(card("ai", ai.fixtures.full)).toContain("AI visibility 30.0% up 7.5 pts (better)");
    const change = DASHBOARD_MODULES.find((x) => x.id === "ai")!.changes!(ai.fixtures.full)[0]!;
    expect([change.format(change.from), change.format(change.to)]).toEqual(["22.5%", "30.0%"]);
  });
});

describe("module changes", () => {
  const fixtures: Record<string, { full: unknown; sparse: unknown }> = {
    google: google.fixtures,
    ga4: ga4.fixtures,
    rank: rank.fixtures,
    local: local.fixtures,
    domains: domains.fixtures,
    audit: audit.fixtures,
    backlinks: backlinks.fixtures,
    ai: ai.fixtures,
  };

  it.each(Object.keys(fixtures))("%s names a baseline and lists changes only when there is an earlier value", (id) => {
    const m = DASHBOARD_MODULES.find((x) => x.id === id)!;
    const { full, sparse } = fixtures[id];
    expect(m.baseline?.(full)).toBeTruthy();
    expect(m.changes?.(full).filter(Boolean).length).toBeGreaterThan(0);
    expect(m.baseline?.(sparse)).toBeNull();
    expect(m.changes?.(sparse).filter(Boolean)).toEqual([]);
  });
});
