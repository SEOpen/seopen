import { describe, expect, it } from "vitest";
import { recapMessage } from "@/lib/email";
import { dashboard as ai } from "@/modules/ai/dashboard";
import { fixtures as aiFixtures } from "@/modules/ai/dashboard.fixtures";
import { dashboard as audit } from "@/modules/audit/dashboard";
import { fixtures as auditFixtures } from "@/modules/audit/dashboard.fixtures";
import { dashboard as google, type GoogleDashboardData } from "@/modules/google/dashboard";
import { addDays } from "@/modules/google/windowing";
import { dashboard as rank } from "@/modules/rank/dashboard";
import { fixtures as rankFixtures } from "@/modules/rank/dashboard.fixtures";
import { projectRecap, type RecapClosest, type RecapSource } from "./content";

/** The fixtures' data ends on 2026-10-27; the recap goes out the Monday after. */
const NOW = new Date("2026-11-02T15:00:00Z");
const ORIGIN = "https://app.example.test";
const project = { id: 7, name: "Fernhill", domain: "fernhill.example" };
const none = { open: 0, newThisWeek: 0 };

/** Search Console with `before` clicks a day for the first 7 days of 14 and `after` for the last 7. */
function searchConsole(before: number, after: number, end = "2026-10-30"): GoogleDashboardData {
  const series = Array.from({ length: 28 }, (_, i) => ({ date: addDays(end, i - 27), clicks: i < 21 ? before : after, position: 9 }));
  const sum = (from: number) => series.slice(from).reduce((n, p) => n + p.clicks, 0);
  return { end, current: { clicks: sum(0), impressions: 50_000, ctr: 0.02, position: 9 }, previous: { clicks: sum(0), impressions: 50_000, ctr: 0.02, position: 9 }, series };
}

const full: RecapSource[] = [
  { module: google, data: searchConsole(100, 130) },
  { module: rank, data: rankFixtures.full },
  { module: ai, data: aiFixtures.full },
  { module: audit, data: auditFixtures.full },
];

const recap = (sources: RecapSource[], fixes = none, now = NOW, closest: RecapClosest | null = null) => projectRecap({ project, sources, fixes, closest, now, origin: ORIGIN });

const closePages: RecapClosest = {
  period: { start: "2026-10-03", end: "2026-10-30" },
  pages: [
    { url: "https://fernhill.example/emergency", query: "emergency plumber", position: 6, impressions: 1_400 },
    { url: "https://fernhill.example/drains", query: "drain repair", position: 12.4, impressions: 300 },
    { url: "https://fernhill.example/", query: "plumber", position: 9, impressions: 1 },
    { url: "https://fernhill.example/heaters", query: "water heater", position: 18, impressions: 90 },
  ],
};

describe("projectRecap", () => {
  it("says what moved, each line with what it's compared with, and links to the project", () => {
    const r = recap(full)!;
    expect(r.href).toBe(`${ORIGIN}/projects/7`);
    const texts = r.lines.map((l) => l.text);
    expect(texts[0]).toBe("Search Console clicks up 30% in the last 7 days, from 700 to 910");
    expect(r.lines[0].against).toBe("to Oct 30, vs the 7 days before");
    expect(texts).toContain("Tracked position improved 1.5 places, from 16.1 to 14.6");
    expect(texts).toContain("AI answers naming you up, from 9 to 12 of 40");
    expect(r.lines.find((l) => l.text.startsWith("Tracked position"))?.against).toBe("vs Oct 20");
    expect(r.lines.find((l) => l.text.startsWith("AI answers"))?.against).toBe("vs previous run");
    expect(r.lines.find((l) => l.text.startsWith("Errors"))).toMatchObject({ text: "Errors down 12, from 49 to 37", against: "vs previous crawl", tone: "good" });
    for (const l of r.lines) expect(l.against).toMatch(/^(vs |to |none new |found )/);
  });

  it("leaves out a card whose newest data is more than a week old", () => {
    const later = new Date("2026-11-20T15:00:00Z");
    expect(recap(full, none, later)).toBeNull();
    // Search Console runs a few days behind, so its week can end three days before the last 7.
    const lagging = recap([{ module: google, data: searchConsole(100, 130, "2026-10-24") }], none, new Date("2026-11-03T15:00:00Z"));
    expect(lagging?.lines).toHaveLength(1);
  });

  it("says nothing for a project where nothing moved", () => {
    expect(recap([{ module: google, data: searchConsole(100, 100) }, { module: rank, data: rankFixtures.sparse }, { module: ai, data: aiFixtures.sparse }, { module: audit, data: auditFixtures.sparse }])).toBeNull();
    expect(recap([])).toBeNull();
  });

  it("doesn't count a few clicks either way as news", () => {
    expect(recap([{ module: google, data: searchConsole(1, 2) }])).toBeNull();
  });

  it("adds open fixes to a project that moved, but they alone don't make a section", () => {
    expect(recap([], { open: 12, newThisWeek: 0 })).toBeNull();
    const moved = recap([{ module: audit, data: auditFixtures.full }], { open: 12, newThisWeek: 0 })!;
    expect(moved.lines.at(-1)).toEqual({ text: "12 fixes still open", against: "none new in the last 7 days", tone: "neutral" });
  });

  it("counts new fixes as news on their own", () => {
    const r = recap([], { open: 4, newThisWeek: 1 })!;
    expect(r.lines).toEqual([{ text: "1 new fix to make, 4 open in all", against: "found in the last 7 days", tone: "bad" }]);
  });

  it("lists up to 3 pages closest to page one, each with its search, position and impressions, and where they're from", () => {
    const r = recap(full, none, NOW, closePages)!;
    expect(r.closest?.heading).toBe("3 pages closest to page one");
    expect(r.closest?.lines).toEqual([
      { text: "/emergency: “emergency plumber” at position 6, 1,400 impressions", against: "Search Console, Oct 3 to Oct 30, 2026", tone: "neutral" },
      { text: "/drains: “drain repair” at position 12.4, 300 impressions", against: "Search Console, Oct 3 to Oct 30, 2026", tone: "neutral" },
      { text: "/: “plumber” at position 9, 1 impression", against: "Search Console, Oct 3 to Oct 30, 2026", tone: "neutral" },
    ]);
    expect(recap(full, none, NOW, { ...closePages, pages: closePages.pages.slice(0, 1) })!.closest?.heading).toBe("The page closest to page one");
  });

  it("leaves the close pages out when there are none or they're old, and they don't make a section alone", () => {
    expect(recap(full, none, NOW, { ...closePages, pages: [] })!.closest).toBeNull();
    expect(recap(full)!.closest).toBeNull();
    expect(recap(full, none, NOW, { ...closePages, period: { start: "2026-09-01", end: "2026-10-20" } })!.closest).toBeNull();
    expect(recap([], none, NOW, closePages)).toBeNull();
  });

  it("lists the week's alerts with where they came from and the day, and they make a section alone", () => {
    const alerts = [
      { title: "/pricing answers 404", source: "Site audit crawl", day: "2026-10-31", resolved: false },
      { title: "“drain repair” left the top 10", source: "Rank check", day: "2026-10-29", resolved: true },
    ];
    const only = projectRecap({ project, sources: [], fixes: none, alerts, now: NOW, origin: ORIGIN })!;
    expect(only.lines).toEqual([]);
    expect(only.alerts).toEqual({
      heading: "2 alerts this week",
      lines: [
        { text: "/pricing answers 404", against: "Site audit crawl, Oct 31", tone: "bad" },
        { text: "“drain repair” left the top 10", against: "Rank check, Oct 29, fixed since", tone: "neutral" },
      ],
    });
    const many = Array.from({ length: 7 }, (_, i) => ({ ...alerts[0], title: `/p${i} answers 404` }));
    expect(projectRecap({ project, sources: [], fixes: none, alerts: many, now: NOW, origin: ORIGIN })!.alerts).toMatchObject({ heading: "7 alerts this week, the latest 5", lines: { length: 5 } });
    expect(recap(full)!.alerts).toBeNull();
  });
});

describe("recapMessage", () => {
  const section = { name: "Fern <hill>", domain: "fernhill.example", href: `${ORIGIN}/projects/7`, lines: recap(full)!.lines };
  const message = recapMessage({ sections: [section], weekTo: "Nov 2", appUrl: ORIGIN, settingsUrl: `${ORIGIN}/settings`, unsubscribeUrl: `${ORIGIN}/api/email/unsubscribe?t=abc.def` });

  it("carries one-click unsubscribe headers and the link in both versions", () => {
    expect(message.headers).toEqual({ "List-Unsubscribe": `<${ORIGIN}/api/email/unsubscribe?t=abc.def>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(message.html).toContain(`href="${ORIGIN}/api/email/unsubscribe?t=abc.def"`);
    expect(message.text).toContain(`Unsubscribe: ${ORIGIN}/api/email/unsubscribe?t=abc.def`);
  });

  it("escapes what comes from the project and names it in the subject", () => {
    expect(message.subject).toBe("Your week in SEOpen: Fern <hill>");
    expect(message.html).toContain("Fern &lt;hill&gt;");
    expect(message.html).not.toContain("Fern <hill>");
    expect(message.text).toContain("- Search Console clicks up 30% in the last 7 days, from 700 to 910 (to Oct 30, vs the 7 days before)");
    expect(message.html).toContain(`href="${ORIGIN}/projects/7"`);
  });

  it("adds the close pages under their heading, and nothing when there are none", () => {
    const closest = recap(full, none, NOW, closePages)!.closest;
    const withPages = recapMessage({ sections: [{ ...section, closest }], weekTo: "Nov 2", appUrl: ORIGIN, settingsUrl: "s", unsubscribeUrl: "u" });
    expect(withPages.text).toContain("3 pages closest to page one:\n- /emergency: “emergency plumber” at position 6, 1,400 impressions (Search Console, Oct 3 to Oct 30, 2026)");
    expect(withPages.html).toContain(">3 pages closest to page one</h3>");
    expect(withPages.html).toContain("/drains: “drain repair” at position 12.4, 300 impressions");
    expect(message.text + message.html).not.toContain("closest to page one");
  });

  it("adds the week's alerts under their heading, before the close pages", () => {
    const alerts = projectRecap({ project, sources: [], fixes: none, alerts: [{ title: "/pricing answers 404", source: "Site audit crawl", day: "2026-10-31", resolved: false }], now: NOW, origin: ORIGIN })!.alerts;
    const closest = recap(full, none, NOW, closePages)!.closest;
    const both = recapMessage({ sections: [{ ...section, lines: [], alerts, closest }], weekTo: "Nov 2", appUrl: ORIGIN, settingsUrl: "s", unsubscribeUrl: "u" });
    expect(both.text).toContain("1 alert this week:\n- /pricing answers 404 (Site audit crawl, Oct 31)\n3 pages closest to page one:");
    expect(both.html).toContain(">1 alert this week</h3>");
    expect(both.html.indexOf("1 alert this week")).toBeLessThan(both.html.indexOf("closest to page one"));
  });

  it("counts projects in the subject when there are several, and never uses an em dash", () => {
    const two = recapMessage({ sections: [section, { ...section, name: "", domain: "b.example" }], weekTo: "Nov 2", appUrl: ORIGIN, settingsUrl: "s", unsubscribeUrl: "u" });
    expect(two.subject).toBe("Your week in SEOpen: 2 projects");
    expect(two.html + two.text).not.toContain("—");
  });
});
