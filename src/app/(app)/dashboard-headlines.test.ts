import { describe, expect, it, vi } from "vitest";
import type { AnyDashboardModule } from "@/components/ui/module-card";
import { failedCheck, type CheckFailure } from "@/lib/check-failure";
import { waitingOnFirstRun } from "@/modules/ai/brief";
import * as ai from "@/modules/ai/dashboard.fixtures";
import * as audit from "@/modules/audit/dashboard.fixtures";
import * as backlinks from "@/modules/backlinks/dashboard.fixtures";
import type { GoogleDashboardData } from "@/modules/google/dashboard";
import * as google from "@/modules/google/dashboard.fixtures";
import * as ga4 from "@/modules/google/ga4-dashboard.fixtures";
import * as local from "@/modules/local/dashboard.fixtures";
import * as rank from "@/modules/rank/dashboard.fixtures";
import { buildHeadlines, clicksThisWeek, finishLine, overviewSentence, waitingEmpty } from "./dashboard-headlines";
import type { ModuleResult } from "./dashboard-load";
import { DASHBOARD_MODULES } from "./dashboard-modules";
import { rules } from "@/plan-policy/rules";

// The real modules' loaders import server-only code; only their pure parts run here.
vi.mock("server-only", () => ({}));

const FULL: Record<string, unknown> = { google: google.fixtures.full, rank: rank.fixtures.full, ai: ai.fixtures.full, audit: audit.fixtures.full };

function results(overrides: Record<string, Partial<ModuleResult> | { data: unknown }> = {}): ModuleResult[] {
  return DASHBOARD_MODULES.map((module: AnyDashboardModule): ModuleResult => {
    if (overrides[module.id]) return { module, status: "ok", ...overrides[module.id] } as ModuleResult;
    return module.id in FULL ? { module, status: "ok", data: FULL[module.id] } : { module, status: "empty" };
  });
}

const rowsOf = (r: ModuleResult[], gscConnected = true) => Object.fromEntries(buildHeadlines(r, { gscConnected }).rows.map((x) => [x.key, x]));
const figuresOf = (r: ModuleResult[], gscConnected = true) => Object.fromEntries(buildHeadlines(r, { gscConnected }).figures.map((x) => [x.id, x]));

/** `days` of 10 clicks a day ending Oct 30, with `previous` set as the loader sets it. */
function gsc(days: number, previous: boolean): GoogleDashboardData {
  const series = Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 30 - (days - 1 - i))).toISOString().slice(0, 10), clicks: 10, position: 5 }));
  const totals = { clicks: 0, impressions: 0, ctr: 0, position: 0 };
  return { end: "2026-10-30", current: totals, previous: previous ? totals : null, series };
}

describe("clicksThisWeek", () => {
  it("sums the latest 7 days against the 7 before", () => {
    const d = gsc(28, true);
    d.series[d.series.length - 1].clicks = 100; // Oct 30, in the week
    d.series[d.series.length - 8].clicks = 50; // Oct 23, the week before
    expect(clicksThisWeek(d)).toEqual({ days: 7, current: 160, previous: 110 });
  });

  it("counts a missing day as zero once stored history is known to reach it", () => {
    const d = gsc(28, true);
    d.series = d.series.filter((p) => p.date !== "2026-10-30");
    expect(clicksThisWeek(d)).toEqual({ days: 7, current: 60, previous: 70 });
  });

  it("has nothing to compare before two full weeks of history", () => {
    expect(clicksThisWeek(gsc(10, false))).toEqual({ days: 7, current: 70, previous: null });
    expect(clicksThisWeek(gsc(14, false))).toEqual({ days: 7, current: 70, previous: 70 });
  });

  it("says how many days it has on a new property, not 7", () => {
    expect(clicksThisWeek(gsc(3, false))).toEqual({ days: 3, current: 30, previous: null });
  });
});

describe("overviewSentence", () => {
  /** Only the given modules loaded, with the rest not set up. */
  const only = (data: Record<string, unknown>) =>
    DASHBOARD_MODULES.map((module: AnyDashboardModule): ModuleResult => (module.id in data ? { module, status: "ok", data: data[module.id] } : { module, status: "empty" }));

  const { current: aiNow, previous: aiBefore } = ai.fixtures.full;
  /** Cited share up 4.5 pts and AI visibility down 1.7 pts, on a run with more prompts: the two can part ways. */
  const parted = { ...ai.fixtures.full, current: { ...aiNow, total: 88, cited: 4, mentioned: 4, citedRate: 0.045, score: 0.045 }, previous: { ...aiBefore!, total: 48, cited: 0, mentioned: 3, citedRate: 0, score: 0.062 } };

  const sessions = (now: number, before: number) => ({ ...ga4.fixtures.full, current: { ...ga4.fixtures.full.current, sessions: now }, previous: { ...ga4.fixtures.full.previous!, sessions: before } });
  const clicks = (now: number, before: number) => ({ ...google.fixtures.full, current: { ...google.fixtures.full.current, clicks: now }, previous: { ...google.fixtures.full.previous!, clicks: before } });

  it("says AI visibility's fall beside the rise in citing, and what they compare against once", () => {
    expect(overviewSentence(only({ ai: parted }))).toBe("AI visibility fell 1.7 points, but the share of AI answers citing you rose 4.5 points since the previous run.");
  });

  it("doesn't lead with a number the strip doesn't show when one it does moved", () => {
    expect(overviewSentence(only({ ai: parted, ga4: sessions(37, 14) }))).toMatch(/^AI visibility fell/);
    expect(overviewSentence(only({ google: clicks(600, 1000), ga4: sessions(5000, 1000) }))).toMatch(/^Clicks are down 40%/);
  });

  it("still says a fall the strip doesn't show, after the rise it does", () => {
    expect(overviewSentence(only({ google: clicks(1400, 1000), ga4: sessions(600, 1000) }))).toBe("Clicks are up 40%, but organic sessions are down 40% on the 28 days before.");
  });

  it("gives the two numbers for a small count, when nothing on the strip moved", () => {
    expect(overviewSentence(only({ ga4: sessions(37, 14) }))).toBe("Organic sessions are up from 14 to 37 on the 28 days before.");
  });

  it("doesn't give one half of AI's parted numbers next to another fall", () => {
    const line = overviewSentence(only({ ai: { ...parted, previous: { ...parted.previous, score: 0.046 }, current: { ...parted.current, score: 0.04 } }, google: clicks(100, 1000) }));
    expect(line).toBe("Clicks are down 90% on the 28 days before.");
  });

  it("is calm when nothing moved", () => {
    const totals = { clicks: 1000, impressions: 40_000, ctr: 0.025, position: 12 };
    expect(overviewSentence(only({ google: { ...google.fixtures.full, current: totals, previous: totals, series: [] } }))).toMatch(/^Nothing moved/);
  });

  it("isn't calm when only a number further down the page moved", () => {
    expect(overviewSentence(only({ google: clicks(1000, 1000) }))).toBe("Only small changes against the last checks.");
    const flat = { score: 0, errors: 10, warnings: 40, notices: 0, pagesWithErrors: 0 };
    expect(overviewSentence(only({ audit: { ...audit.fixtures.full, changes: flat } }))).toBe("Only small changes against the last checks.");
  });
});

describe("overviewSentence with a page one gain no look confirmed", () => {
  const { latest, previous } = rank.fixtures.full;
  const gain = { ...rank.fixtures.full, latest: { ...latest, top10: 80 }, previous: { ...previous!, top10: 60 }, pageOneGainsNotConfirmed: 20 };
  const quiet = { ai: { status: "empty" as const }, audit: { status: "empty" as const } };

  it("says it plainly when it's all there is", () => {
    expect(overviewSentence(results({ rank: { data: gain }, google: { status: "empty" }, ...quiet }))).toMatch(/^20 more keywords show on page one than on .+, with none of the gain confirmed\.$/);
  });

  it("doesn't lead over a move a check confirmed, and doesn't read as its counterpoint", () => {
    const beside = (clicks: number) => overviewSentence(results({ rank: { data: gain }, ...quiet, google: { data: { ...google.fixtures.full, current: { ...google.fixtures.full.current, clicks }, previous: { ...google.fixtures.full.previous!, clicks: 1000 } } } }));
    expect(beside(1100)).toMatch(/^Clicks .+, and 20 more keywords show on page one/);
    expect(beside(600)).toMatch(/^Clicks .+, and 20 more keywords show on page one/);
  });
});

describe("buildHeadlines rows", () => {
  it("always has the same four rows in the same order", () => {
    for (const r of [results(), results({ google: { status: "empty" }, rank: { status: "failed", slow: true } })]) {
      expect(buildHeadlines(r, { gscConnected: false }).rows.map((x) => x.key)).toEqual(["clicks", "position", "cited", "errors"]);
    }
  });

  it("says what each value compares against", () => {
    const rows = rowsOf(results());
    // The chart beside it reads 28 days, so the row says its own window.
    expect(rows.clicks.label).toBe("Clicks, last 7 days");
    expect(rows.clicks.meta).toMatch(/^to .+, vs the 7 before$/);
    expect(rows.position.meta).toMatch(/^vs Oct \d+$/);
    expect(rows.cited.meta).toBe("vs previous run");
    expect(rows.errors.meta).toMatch(/· vs previous crawl$/);
  });

  it("colours a rising error count bad and a lower position good, whatever the sign", () => {
    const rows = rowsOf(results({ audit: { data: { ...audit.fixtures.full, latest: { ...audit.fixtures.full.latest!, pagesWithErrors: 17 }, changes: { ...audit.fixtures.full.changes!, pagesWithErrors: 9 } } } }));
    expect(rows.errors).toMatchObject({ from: "8", to: "17", delta: { text: "+9", tone: "bad", up: true } });
    expect(rows.position).toMatchObject({ from: "16.1", to: "14.6", delta: { text: "1.5 better", tone: "good", up: true } });
  });

  it("words a row's count the way What changed does, and keeps its change from zero", () => {
    const errors = (pagesWithErrors: number, change: number) => rowsOf(results({ audit: { data: { ...audit.fixtures.full, latest: { ...audit.fixtures.full.latest!, pagesWithErrors }, changes: { ...audit.fixtures.full.changes!, pagesWithErrors: change } } } })).errors;
    expect(errors(60, -40)).toMatchObject({ from: "100", to: "60", delta: { text: "−40%", tone: "good" } });
    expect(errors(60, 60)).toMatchObject({ from: "0", to: "60", delta: { text: "+60", tone: "bad" } });
  });

  it("shows the earlier total only when it differs", () => {
    const { current, previous } = ai.fixtures.full;
    expect(rowsOf(results()).cited).toMatchObject({ from: "6", to: "7 of 40" });
    const grown = { ...ai.fixtures.full, current: { ...current, total: 50 }, previous };
    expect(rowsOf(results({ ai: { data: grown } })).cited).toMatchObject({ from: "6 of 40", to: "7 of 50" });
  });

  it("gives a value with nothing earlier no change and no baseline", () => {
    const rows = rowsOf(results({ rank: { data: rank.fixtures.sparse }, ai: { data: ai.fixtures.sparse }, audit: { data: audit.fixtures.sparse } }));
    for (const key of ["position", "cited"]) expect(rows[key]).toMatchObject({ state: "value", delta: null, from: undefined, meta: undefined });
    expect(rows.errors).toMatchObject({ state: "value", delta: null, from: undefined });
    expect((rows.errors as { meta: string }).meta).not.toContain("vs");
  });

  it("tells not connected from connected with nothing synced", () => {
    const r = results({ google: { status: "empty" } });
    expect(rowsOf(r, false).clicks).toMatchObject({ state: "empty", text: "Not connected", action: "Connect", href: "/gsc" });
    expect(rowsOf(r, true).clicks).toMatchObject({ state: "empty", text: "Nothing synced yet", action: "View" });
    expect(figuresOf(r, false).clicks).toMatchObject({ state: "empty", text: "Not connected", action: { label: "Connect Search Console", href: "/gsc" } });
  });

  it("says when a module is waiting, not set up, or failed", () => {
    const rows = rowsOf(results({ rank: { status: "empty", waiting: "8 keywords tracked, waiting for the first check" }, ai: { status: "empty" }, audit: { status: "failed", slow: true } }));
    expect(rows.position).toMatchObject({ state: "empty", text: "Waiting for first check", action: "View" });
    expect(rows.cited).toMatchObject({ state: "empty", text: "No tracked prompts", action: "Add prompts", href: "/ai/prompts" });
    expect(rows.errors).toMatchObject({ state: "empty", text: "Took too long to load", tone: "bad" });
  });

  it("says Free doesn't ask the tracked prompts, not that they wait", () => {
    const r = results({ ai: { status: "empty", waiting: waitingOnFirstRun(3, true) } });
    expect(rowsOf(r).cited).toMatchObject({ state: "empty", text: "Not on the Free plan", action: "View" });
    expect(rowsOf(results({ ai: { status: "empty", waiting: waitingOnFirstRun(3, false) } })).cited).toMatchObject({ text: "Waiting for first run" });
  });

  it("says a first check is running, not waiting", () => {
    const r = results({ rank: { status: "empty", waiting: "8 keywords tracked, the first check is running" } });
    expect(rowsOf(r).position).toMatchObject({ state: "empty", text: "First check running", action: "View" });
    expect(figuresOf(r)["page-one"]).toMatchObject({ state: "empty", text: "8 keywords tracked, the first check is running" });
  });

  it("says Free doesn't check tracked keywords, not that they wait", () => {
    const r = results({ rank: { status: "empty", waiting: "3 keywords tracked, not checked on the Free plan" } });
    expect(rowsOf(r).position).toMatchObject({ state: "empty", text: "Not on the Free plan", action: "View" });
  });

  it("says how much of Tracked position rests on positions not confirmed, in the strip and the row", () => {
    const r = results({ rank: { data: rank.fixtures.more!["positions not confirmed"] } });
    expect(figuresOf(r).position).toMatchObject({ caption: "31 of 48 ranking, 4 not confirmed, 16.0 without them, vs Oct 20" });
    expect(rowsOf(r).position).toMatchObject({ meta: "vs Oct 20, 4 not confirmed, 16.0 without them" });
    expect(figuresOf(results()).position).toMatchObject({ caption: "31 of 48 ranking, vs Oct 20" });
    expect(rowsOf(results()).position).toMatchObject({ meta: "vs Oct 20" });
  });

  it("handles a first crawl still running and keywords that don't rank", () => {
    const rows = rowsOf(results({ audit: { data: audit.fixtures.more!["first crawl running"] }, rank: { data: rank.fixtures.more!["nothing ranks"] } }));
    expect(rows.errors).toMatchObject({ state: "empty", text: "Crawl running, no results yet" });
    expect(rows.position).toMatchObject({ state: "empty", text: "No keywords ranking yet" });
  });
});

describe("buildHeadlines also moved", () => {
  it("doesn't repeat what the fixed rows show, and keeps a baseline without the year", () => {
    // Errors stays: the fixed row counts pages, and one page can have several errors.
    const { also } = buildHeadlines(results(), { gscConnected: true });
    const keys = also.map((a) => a.key);
    expect(keys).not.toContain("google:Clicks");
    expect(keys).not.toContain("rank:Tracked position");
    expect(keys).toContain("audit:Errors");
    for (const a of also) expect(a.meta).toMatch(/^vs (?!.*\d{4}$)/);
  });

  it("names where a position or visibility comes from", () => {
    const moved = (data: Record<string, unknown>) => buildHeadlines(results(Object.fromEntries(Object.entries(data).map(([id, d]) => [id, { data: d }]))), { gscConnected: true }).also.map((a) => a.label);
    const { current, previous } = google.fixtures.full;
    const gsc = { ...google.fixtures.full, current: { ...current, impressions: 500, position: 8 }, previous: { ...previous!, impressions: 500, position: 12 } };
    expect(moved({ google: gsc })).toContain("Search Console position");
    const { latest, previous: before } = rank.fixtures.full;
    const movedRank = { rank: { data: { ...rank.fixtures.full, latest: { ...latest, visibility: 0.3 }, previous: { ...before!, visibility: 0.1 } } } };
    expect(buildHeadlines(results(movedRank), { gscConnected: true }).also.find((a) => a.key === "rank:Visibility")).toMatchObject({ label: "Visibility", source: "Rankings" });
    expect(moved({ ai: ai.fixtures.full })).toContain("AI visibility");
  });

  it("uses the strip's and the module page's names", () => {
    const { latest, previous: before } = rank.fixtures.full;
    const data = { rank: { data: { ...rank.fixtures.full, latest: { ...latest, top10: before!.top10 + 20 } } } };
    const labels = buildHeadlines(results(data), { gscConnected: true }).also.map((a) => a.label);
    expect(labels).toContain("On page one");
    expect(labels).not.toContain("Top 10");
  });
});

describe("buildHeadlines figures", () => {
  it("reads each figure from real module data, with a gauge only on position", () => {
    const r = figuresOf(results());
    expect(r.clicks).toMatchObject({ state: "value", label: "Clicks", delta: { tone: "good" } });
    expect(r.clicks.caption).toMatch(/^28 days to .+, vs the 28 before$/);
    expect(r.position).toMatchObject({ label: "Tracked position", value: "14.6", delta: { text: "1.5 better", up: true }, position: { value: 14.6 } });
    // The average covers only the keywords that rank.
    expect(r.position.caption).toMatch(/^31 of 48 ranking, vs Oct \d+$/);
    expect(r.cited).toMatchObject({ label: "AI citing you", value: "7 of 40", delta: { text: "+1" } });
    expect(r.cited.caption).toBe("5 platforms, vs previous run");
    expect(r["page-one"]).toMatchObject({ state: "value" });
    expect(r.health).toMatchObject({ state: "value" });
    expect(r.health.caption).toMatch(/^out of 100, crawled /);
    for (const id of ["clicks", "page-one", "cited", "health"]) expect(r[id]).not.toHaveProperty("position");
  });

  it("says how many AI answers failed, and doesn't say nothing earlier after a run that got nothing back", () => {
    const failed = figuresOf(results({ ai: { data: { ...ai.fixtures.full, failed: 6 } } }));
    expect(failed.cited.caption).toBe("5 platforms, 6 failed, vs previous run");
    const stale = figuresOf(results({ ai: { data: { ...ai.fixtures.full, previous: null, failedRun: true } } }));
    expect(stale.cited).toMatchObject({ value: "7 of 40", delta: null, caption: "5 platforms" });
  });

  it("compares shares when the prompts changed", () => {
    const { current, previous } = ai.fixtures.full;
    const grown = { ...ai.fixtures.full, current: { ...current, total: 50, citedRate: previous!.citedRate! + 0.04 } };
    expect(figuresOf(results({ ai: { data: grown } })).cited).toMatchObject({ delta: { text: "+4 pts", tone: "good" } });
  });

  it("names Search Console's position as that, when nothing is tracked", () => {
    const r = figuresOf(results({ rank: { status: "empty" } }));
    expect(r.position).toMatchObject({ state: "value", label: "Search Console position", href: "/gsc", position: { value: expect.any(Number) } });
    expect(r.position.caption).toContain("vs the 28 days before");
  });

  it("offers Add keywords when there's neither", () => {
    const r = figuresOf(results({ rank: { status: "empty" }, google: { status: "empty" } }));
    expect(r.position).toMatchObject({ state: "empty", label: "Tracked position", action: { label: "Add keywords", href: "/rank" } });
  });

  it("says when there is nothing earlier to compare", () => {
    const r = figuresOf(results({ google: { data: google.fixtures.sparse }, rank: { data: rank.fixtures.sparse }, ai: { data: ai.fixtures.sparse } }));
    for (const c of [r.clicks, r.position, r["page-one"], r.cited]) {
      expect(c.caption).toContain("nothing earlier to compare");
      expect(c).toMatchObject({ state: "value", delta: null });
    }
    expect(r.cited.caption).toContain("2 platforms");
    expect(r.position.caption).toBe("1 of 3 ranking, nothing earlier to compare");
  });

  it("says how many days a new property has, not 28", () => {
    const c = figuresOf(results({ google: { data: gsc(4, false) } })).clicks;
    expect(c.label).toBe("Clicks");
    expect(c.caption).toBe("4 days to Oct 30, nothing earlier to compare");
  });

  it.skipIf(!rules.hasPlans)("says rankings and prompts are on Starter on Free, instead of offering to add what Free refuses", () => {
    const empty = results({ rank: { status: "empty" }, google: { status: "empty" }, ai: { status: "empty" } });
    const h = buildHeadlines(empty, { gscConnected: true, free: true });
    const f = Object.fromEntries(h.figures.map((x) => [x.id, x]));
    const plan = { state: "empty", text: "On Starter", href: "/billing", action: { label: "See plans", href: "/billing" } };
    expect(f.position).toMatchObject({ label: "Tracked position", ...plan });
    expect(f["page-one"]).toMatchObject(plan);
    expect(f.cited).toMatchObject(plan);
    const rows = Object.fromEntries(h.rows.map((x) => [x.key, x]));
    expect(rows.position).toMatchObject({ state: "empty", text: "On Starter", action: "See plans", href: "/billing" });
    expect(rows.cited).toMatchObject({ state: "empty", text: "On Starter", action: "See plans", href: "/billing" });
    // A paid plan still gets the way to add them.
    expect(figuresOf(empty).cited).toMatchObject({ action: { label: "Add prompts" } });
  });

  it("keeps Search Console's position and a failure's own words on Free", () => {
    const f = Object.fromEntries(buildHeadlines(results({ rank: { status: "empty" }, ai: { status: "failed", slow: false } }), { gscConnected: true, free: true }).figures.map((x) => [x.id, x]));
    expect(f.position).toMatchObject({ state: "value", label: "Search Console position" });
    expect(f.cited).toMatchObject({ state: "empty", text: "Couldn't load", tone: "bad" });
  });

  it("offers the way forward when a module has nothing to show", () => {
    const r = figuresOf(results({ ai: { status: "empty", waiting: "3 prompts tracked, waiting for the first run" }, google: { status: "failed", slow: false } }));
    expect(r.cited).toMatchObject({ state: "empty", text: "3 prompts tracked, waiting for the first run" });
    expect(r.clicks).toMatchObject({ state: "empty", text: "Couldn't load", tone: "bad" });
  });
});

describe("waitingEmpty", () => {
  it("promises the schedule and Check now on a paid plan", () => {
    const said = waitingEmpty("Site", { free: false, modules: ["Rankings", "AI visibility"], time: "06:00 EST" });
    expect(said.title).toBe("Site is set up and waiting for its first results");
    expect(said.description).toContain("Rankings are checked every day at 06:00 EST");
    expect(said.description).toContain("Check now");
  });

  it("promises nothing Free doesn't run, and says what it does", () => {
    const said = waitingEmpty("Site", { free: true, modules: ["Rankings", "AI visibility"], time: "06:00 EST" });
    expect(said.title).toBe("Nothing to show for Site yet");
    expect(said.description).toBe(
      "The Free plan doesn't check Rankings or AI visibility, so no results are on their way. Choose a plan on the Billing page to start them, or begin with what Free covers: a site audit and Search Console.",
    );
    expect(waitingEmpty("Site", { free: true, modules: ["Rankings"], time: "06:00 EST" }).description).toMatch(/^The Free plan doesn't check Rankings, so/);
    expect(said.description).not.toMatch(/every day|Check now|weekly/);
  });
});

describe("finishLine", () => {
  it("says when each module last ran and what comes next", () => {
    const line = finishLine(results(), "America/New_York");
    expect(line).toMatch(/^Search Console data to .+\. Rankings checked .+, then daily at \d\d:\d\d \S+\. AI answers from .+, then weekly\. Site crawled .+, then weekly\.$/);
  });

  it("adds Backlinks and Local SEO when they have data, on the one line", () => {
    const line = finishLine(results({ backlinks: { data: backlinks.fixtures.full }, local: { data: local.fixtures.full } }), "UTC")!;
    expect(line).toContain("Backlinks as of Oct 27, then weekly.");
    expect(line).toContain("Local SEO checked Nov 2, then weekly.");
    expect(line).not.toContain("\n");
    expect(finishLine(results(), "UTC")).not.toMatch(/Backlinks|Local SEO/);
  });

  it("promises a next check, crawl or local check only when one is coming", () => {
    const off = results({ rank: { data: { ...rank.fixtures.full, enabled: false } }, audit: { data: { ...audit.fixtures.full, weekly: false } }, local: { data: { ...local.fixtures.full, weekly: false } } });
    const line = finishLine(off, "UTC")!;
    expect(line).toMatch(/Rankings checked Oct 27\./);
    expect(line).not.toContain("then daily");
    expect(line).toMatch(/Site crawled Oct 27\./);
    expect(line).toMatch(/Local SEO checked Nov 2\./);
  });

  it("promises no daily or weekly checks on Free, which runs only the audit", () => {
    const line = finishLine(results({ backlinks: { data: backlinks.fixtures.full }, local: { data: local.fixtures.full } }), "UTC", undefined, true)!;
    expect(line).toMatch(/Rankings checked Oct 27\./);
    expect(line).toMatch(/AI answers from [A-Z][a-z]+ \d+\./);
    expect(line).toMatch(/Local SEO checked Nov 2\./);
    expect(line).toMatch(/Backlinks as of Oct 27\./);
    expect(line).not.toMatch(/then daily|AI answers from [^.]+, then weekly|Backlinks as of [^.]+, then weekly|Local SEO checked [^.]+, then weekly/);
    // The audit still runs weekly on Free.
    expect(line).toMatch(/Site crawled [^.]+, then weekly\./);
  });

  it("is null with nothing loaded, and leaves out a running first crawl", () => {
    expect(finishLine(results({ google: { status: "empty" }, rank: { status: "empty" }, ai: { status: "empty" }, audit: { status: "empty" } }), "UTC")).toBeNull();
    expect(finishLine(results({ audit: { data: audit.fixtures.more!["first crawl running"] } }), "UTC")).not.toContain("crawled");
  });
});

describe("a source whose newest check failed", () => {
  const checkFailed = failedCheck({ noun: "check", at: new Date("2026-11-07T12:00:00Z"), timeZone: "UTC", reason: "None of this check's searches came back.", retry: true, next: { label: "View", href: "/rank" } });
  const crawlRejected = failedCheck({ noun: "crawl", at: new Date("2026-11-07T12:00:00Z"), timeZone: "UTC", reason: "Check the project's domain.", retry: false, next: { label: "Open Project settings", href: "/projects/1/settings" } });
  const reconnect: CheckFailure = { kind: "reconnect", noun: "sync", at: null, day: null, reason: "Why.", retry: false, next: { label: "Reconnect", href: "/gsc" }, provider: "Google" };
  const withFailure = (list: ModuleResult[], failures: Record<string, CheckFailure>) => list.map((r): ModuleResult => (failures[r.module.id] ? { ...r, lastRunFailed: failures[r.module.id] } : r));
  const noResults = (ids: string[]) => results(Object.fromEntries(ids.map((id) => [id, { status: "empty" }])));

  it("says which source first, and only what the healthy ones moved", () => {
    const list = withFailure(results(), { rank: checkFailed });
    const said = overviewSentence(list);
    expect(said).toMatch(/^Rankings need a look: the last check failed on Nov 7\./);
    expect(said).not.toMatch(/page one|small changes|steady/i);
  });

  it("doesn't say small changes when every source failed", () => {
    const list = withFailure(results(), { rank: checkFailed, audit: crawlRejected, ai: { ...checkFailed, noun: "run" }, google: reconnect });
    const said = overviewSentence(list);
    expect(said).toBe("AI visibility, Rankings, and Site audit need a look: their latest checks failed. Reconnect Google to update Search Console.");
  });

  it("doesn't say waiting for the first sync over a broken connection", () => {
    const list = withFailure(noResults(["google"]), { google: reconnect });
    const clicks = figuresOf(list).clicks;
    expect(clicks).toMatchObject({ state: "empty", text: "Reconnect Google", tone: "bad", action: { label: "Reconnect", href: "/gsc" } });
    expect(rowsOf(list).clicks).toMatchObject({ state: "empty", text: "Reconnect Google", action: "Reconnect", href: "/gsc" });
  });

  it("doesn't call a failed audit not set up, and points at the fix", () => {
    const list = withFailure(noResults(["audit"]), { audit: crawlRejected });
    expect(figuresOf(list).health).toMatchObject({ state: "empty", text: "Last crawl failed Nov 7", tone: "bad", action: { label: "Open Project settings", href: "/projects/1/settings" } });
    expect(rowsOf(list).errors).toMatchObject({ state: "empty", text: "Last crawl failed Nov 7", action: "Open Project settings" });
  });

  it("keeps the older numbers, labelled, and offers View with the module's name", () => {
    const list = withFailure(results(), { rank: checkFailed });
    const figures = figuresOf(list);
    expect(figures["page-one"].state).toBe("value");
    expect(figures["page-one"].caption).toMatch(/last check failed Nov 7\.$/i);
    expect(figures.position.caption).toMatch(/last check failed Nov 7\.$/i);
    const row = rowsOf(list).position;
    expect(row.state === "value" && row.meta).toMatch(/· last check failed Nov 7$/);
    expect(figuresOf(withFailure(noResults(["rank"]), { rank: checkFailed }))["page-one"]).toMatchObject({ action: { label: "View Rankings", href: "/rank" } });
  });

  it("gives a loader that threw priority over a failure it can't back up", () => {
    const list = withFailure(results({ rank: { status: "failed", slow: true } }), { rank: checkFailed });
    expect(figuresOf(list)["page-one"]).toMatchObject({ state: "empty", tone: "bad" });
    expect((figuresOf(list)["page-one"] as { text: string }).text).toMatch(/Took too long/);
  });

  it("leaves a failing source out of Also moved", () => {
    const moved = buildHeadlines(results(), { gscConnected: true }).also.filter((r) => r.source === "Rankings");
    const list = withFailure(results(), { rank: checkFailed });
    expect(moved.length).toBeGreaterThan(0);
    expect(buildHeadlines(list, { gscConnected: true }).also.filter((r) => r.source === "Rankings")).toEqual([]);
  });

  it("ends the page on the failure, not on what runs next", () => {
    const line = finishLine(withFailure(results(), { rank: checkFailed }), "UTC");
    expect(line).toMatch(/Rankings checked [A-Z][a-z]+ \d+, last check failed Nov 7\./);
    expect(line).not.toMatch(/Rankings checked [A-Z][a-z]+ \d+, then daily/);
  });

  it("says the backlink numbers are older than a snapshot that couldn't run", () => {
    const snapshotFailed = { ...checkFailed, next: { label: "View", href: "/backlinks" } };
    const list = withFailure(results({ backlinks: { data: backlinks.fixtures.full } }), { backlinks: snapshotFailed });
    expect(finishLine(list, "UTC")).toContain("Backlinks as of Oct 27, last check failed Nov 7.");
    expect(finishLine(list, "UTC")).not.toMatch(/Backlinks as of [^.]+, then weekly/);
  });
});
