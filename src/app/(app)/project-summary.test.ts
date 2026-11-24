import { describe, expect, it, vi } from "vitest";
import { chartDay } from "@/components/ui/module-card";
import { failedCheck, stoppedData, type CheckFailure } from "@/lib/check-failure";
import { projectIdFromPath } from "@/lib/project-cookie";
import * as ai from "@/modules/ai/dashboard.fixtures";
import * as audit from "@/modules/audit/dashboard.fixtures";
import * as backlinks from "@/modules/backlinks/dashboard.fixtures";
import * as google from "@/modules/google/dashboard.fixtures";
import * as ga4 from "@/modules/google/ga4-dashboard.fixtures";
import { addDays } from "@/modules/google/windowing";
import * as local from "@/modules/local/dashboard.fixtures";
import * as rank from "@/modules/rank/dashboard.fixtures";
import { buildHeadlines } from "./dashboard-headlines";
import type { ModuleResult } from "./dashboard-load";
import { DASHBOARD_MODULES } from "./dashboard-modules";
import { boardSentence, clicksSpark, projectMoves, projectSentence, summarize, worstClause } from "./project-summary";

// The real modules' loaders import server-only code; only their pure parts run here.
vi.mock("server-only", () => ({}));

const FULL: Record<string, unknown> = { google: google.fixtures.full, ga4: ga4.fixtures.full, rank: rank.fixtures.full, audit: audit.fixtures.full, ai: ai.fixtures.full, backlinks: backlinks.fixtures.full };

/** Every module empty, except the given ids with their full fixture or the data given, or failed. */
function results(ok: string[] | Record<string, unknown>, failed: Record<string, boolean> = {}): ModuleResult[] {
  const data: Record<string, unknown> = Array.isArray(ok) ? Object.fromEntries(ok.map((id) => [id, FULL[id]])) : ok;
  return DASHBOARD_MODULES.map((module): ModuleResult => {
    if (module.id in failed) return { module, status: "failed", slow: failed[module.id] };
    return module.id in data ? { module, status: "ok", data: data[module.id] } : { module, status: "empty" };
  });
}

const figure = (s: ReturnType<typeof summarize>, id: string) => s.figures.find((f) => f.id === id)!;

const googleWith = (clicks: number, previous: number | null) => ({
  ...google.fixtures.full,
  current: { ...google.fixtures.full.current, clicks },
  previous: previous == null ? null : { ...google.fixtures.full.previous!, clicks: previous },
});

const ga4With = (sessions: number, previous: number) => ({
  ...ga4.fixtures.full,
  current: { ...ga4.fixtures.full.current, sessions },
  previous: { ...ga4.fixtures.full.previous!, sessions: previous },
});

/** Every module empty, with the given ones set up and waiting for their first results. */
function waitingOn(text: Record<string, string>): ModuleResult[] {
  return DASHBOARD_MODULES.map((module): ModuleResult => (module.id in text ? { module, status: "empty", waiting: text[module.id] } : { module, status: "empty" }));
}

describe("summarize", () => {
  it("always has the same six figures in the same order", () => {
    for (const r of [results(Object.keys(FULL)), results([]), results(["google"], { rank: true })]) {
      expect(summarize(r).figures.map((f) => f.label)).toEqual(["Clicks", "On page one", "AI citing you", "Health score", "Organic sessions", "Backlinks"]);
    }
  });

  it("fills each figure from its module, with no links", () => {
    const s = summarize(results(Object.keys(FULL)));
    expect(figure(s, "clicks")).toMatchObject({ state: "value", value: "4,318", delta: { tone: "good" } });
    expect(figure(s, "clicks").caption).toMatch(/^28 days to /);
    expect(figure(s, "page-one").state).toBe("value");
    expect(figure(s, "cited")).toMatchObject({ value: "7 of 40", delta: { text: "+1" }, caption: "vs the previous run" });
    expect(figure(s, "health").state).toBe("value");
    for (const f of s.figures) expect(f.href).toBeUndefined();
    expect(s.clicksSpark?.label).toBe("Clicks, 28 days");
    expect(s.clicksSpark?.points).toHaveLength(28);
    expect(s.live).toBe(6);
  });

  it("says how many AI answers failed beside the count that leaves them out", () => {
    const s = summarize(results({ ai: { ...ai.fixtures.full, failed: 6 } }));
    expect(figure(s, "cited")).toMatchObject({ value: "7 of 40", caption: "vs the previous run, 6 failed" });
  });

  it("doesn't call AI's numbers a first run when the newest run got nothing back", () => {
    const s = summarize(results({ ai: { ...ai.fixtures.full, previous: null, failedRun: true } }));
    expect(figure(s, "cited")).toMatchObject({ value: "7 of 40", delta: null });
    expect(figure(s, "cited").caption ?? "").not.toMatch(/first run/);
  });

  it("says which snapshots a backlinks change compares", () => {
    expect(figure(summarize(results({ backlinks: backlinks.fixtures.full })), "backlinks").caption).toBe("as of Oct 27, vs Oct 20");
    expect(figure(summarize(results({ backlinks: backlinks.fixtures.sparse })), "backlinks").caption).toBe("as of Oct 27");
  });

  it("tells a failed module from one that isn't set up", () => {
    const s = summarize(results(["google"], { rank: true, audit: false }));
    expect(figure(s, "page-one")).toMatchObject({ state: "empty", text: "Took too long", tone: "bad" });
    expect(figure(s, "health")).toMatchObject({ state: "empty", text: "Couldn't load", tone: "bad" });
    expect(figure(s, "cited")).toMatchObject({ state: "empty", text: "Not set up" });
    expect(s.failed).toEqual([
      { label: "Rankings", slow: true },
      { label: "Site audit", slow: false },
    ]);
    expect(s.status).toBe("attention");
  });

  it("marks a project with nothing set up as empty", () => {
    const s = summarize(results([]));
    expect(s).toMatchObject({ status: "empty", live: 0, worst: 0, biggest: 0, clicksSpark: null });
    expect(s.sentence).toBe("Nothing set up yet.");
  });

  it("tells a project waiting for first results from one with nothing set up", () => {
    const s = summarize(waitingOn({ rank: "8 keywords tracked, waiting for the first check" }));
    expect(s).toMatchObject({ status: "waiting", live: 0, worst: 0 });
    expect(s.sentence).toBe("8 keywords tracked, waiting for the first check.");
    expect(figure(s, "page-one")).toMatchObject({ state: "empty", text: "Waiting for first results" });
  });

  it("says each thing a project is waiting for", () => {
    expect(summarize(waitingOn({ rank: "8 keywords tracked, waiting for the first check", ai: "5 prompts tracked, waiting for the first run" })).sentence).toBe("5 prompts tracked, waiting for the first run. 8 keywords tracked, waiting for the first check.");
  });

  it("doesn't call a failure waiting, or say nothing is set up beside it", () => {
    const allFailed = summarize(results([], { rank: false }));
    expect(allFailed.status).toBe("attention");
    expect(allFailed.sentence).toBe("Couldn't load the numbers for this project.");
  });

  it("counts waiting modules as live once another has data", () => {
    const r = results(["google"]).map((x): ModuleResult => (x.module.id === "rank" ? { module: x.module, status: "empty", waiting: "8 keywords tracked, waiting for the first check" } : x));
    expect(summarize(r).status).not.toBe("waiting");
  });

  it("doesn't flag or rank on a small fall", () => {
    const s = summarize(results({ ga4: ga4With(33, 39) }));
    expect(s).toMatchObject({ status: "steady", worst: 0, biggest: 0 });
    expect(worstClause(results({ ga4: ga4With(33, 39) }))).toBeUndefined();
  });

  it("flags a fall of 20 or more, even on a small base", () => {
    const s = summarize(results({ ga4: ga4With(5, 49) }));
    expect(s.status).toBe("attention");
    expect(s.sentence).toBe("Organic sessions are down from 49 to 5 on the 28 days before.");
  });

  it("doesn't flag one keyword lost from a handful, and flags three", () => {
    const { previous: was, latest } = rank.fixtures.full;
    const oneDown = { ...rank.fixtures.full, previous: { ...was!, top10: 4 }, latest: { ...latest, top10: 3 } };
    expect(summarize(results({ rank: oneDown })).status).toBe("steady");
    const threeDown = { ...rank.fixtures.full, previous: { ...was!, top10: 6 }, latest: { ...latest, top10: 3 } };
    expect(summarize(results({ rank: threeDown })).status).toBe("attention");
  });

  it("doesn't flag site health under three points", () => {
    const withHealth = (score: number) => ({ ...audit.fixtures.full, changes: { ...audit.fixtures.full.changes!, score } });
    expect(summarize(results({ audit: withHealth(-2) })).status).toBe("steady");
    expect(summarize(results({ audit: withHealth(-3) })).status).toBe("attention");
  });

  it("doesn't flag a small backlinks loss, and flags a real one", () => {
    const withLinks = (now: number, before: number) => ({ ...backlinks.fixtures.full, backlinks: now, backlinksChange: now - before, referringDomainsChange: 0 });
    expect(summarize(results({ backlinks: withLinks(30, 35) })).status).toBe("steady");
    expect(summarize(results({ backlinks: withLinks(100, 130) })).status).toBe("attention");
  });

  it("ranks one lost keyword below a 40% fall in clicks", () => {
    const { previous: was, latest } = rank.fixtures.full;
    const oneLost = { ...rank.fixtures.full, previous: { ...was!, top10: 1 }, latest: { ...latest, top10: 0 } };
    expect(worstClause(results({ rank: oneLost, google: googleWith(600, 1000) }))).toBe("clicks are down 40% on the 28 days before");
  });

  it("flags a fall and ranks by how far it went", () => {
    const s = summarize(results({ google: googleWith(600, 1000) }));
    expect(s.status).toBe("attention");
    expect(s.worst).toBeCloseTo(0.4);
    expect(s.sentence).toBe("Clicks are down 40% on the 28 days before.");
  });

  it("stays steady on a rise", () => {
    const s = summarize(results({ google: googleWith(1400, 1000) }));
    expect(s).toMatchObject({ status: "steady", worst: 0 });
    expect(s.biggest).toBeCloseTo(0.4);
  });

  it("shows a small count as a plain difference", () => {
    expect(figure(summarize(results({ google: googleWith(3, 5) })), "clicks")).toMatchObject({ delta: { text: "−2", tone: "bad" } });
  });

  describe("captions", () => {
    const end = google.fixtures.full.end;
    const days = (n: number) => Array.from({ length: n }, (_, i) => addDays(end, i - (n - 1)));
    const gsc = (n: number) => ({ ...google.fixtures.full, previous: null, series: days(n).map((date) => ({ date, clicks: 1, position: null })) });
    const analytics = (n: number) => ({ ...ga4.fixtures.full, end, previous: null, series: days(n).map((date) => ({ date, sessions: 1 })) });

    it("counts the days stored on a new property", () => {
      expect(figure(summarize(results({ google: gsc(5), ga4: analytics(5) })), "clicks").caption).toBe("5 days to Oct 27");
      expect(figure(summarize(results({ google: gsc(5), ga4: analytics(5) })), "sessions").caption).toBe("5 days to Oct 27");
    });
    it("gets one stored day right", () => {
      expect(figure(summarize(results({ google: gsc(1) })), "clicks").caption).toBe("1 day to Oct 27");
      expect(figure(summarize(results({ ga4: analytics(1) })), "sessions").caption).toBe("1 day to Oct 27");
    });
    it("says 28 for a window that is all stored, with or without an earlier period", () => {
      expect(figure(summarize(results({ google: gsc(28) })), "clicks").caption).toBe("28 days to Oct 27");
      expect(figure(summarize(results(["google", "ga4"])), "sessions").caption).toMatch(/^28 days to /);
    });
    it("falls back to the window with no daily rows at all", () => {
      expect(figure(summarize(results({ google: { ...gsc(1), series: [] } })), "clicks").caption).toBe("28 days to Oct 27");
    });
  });
});

describe("projectMoves", () => {
  describe("health score", () => {
    const withHealth = (score: number) => ({ ...audit.fixtures.full, changes: { ...audit.fixtures.full.changes!, score } });
    const clause = (score: number) => projectMoves(results({ audit: withHealth(score) })).find((m) => m.clause.startsWith("health score"))?.clause;

    it("says a fractional change in whole points, and one point in the singular", () => {
      expect(clause(-1.4)).toBe("health score fell one point since the previous crawl");
      expect(clause(1.4)).toBe("health score rose one point since the previous crawl");
    });
    it("isn't thrown by float noise", () => {
      expect(clause(80.4 - 79.4)).toBe("health score rose one point since the previous crawl");
    });
    it("rounds to the nearest point", () => {
      expect(clause(-1.6)).toBe("health score fell two points since the previous crawl");
      expect(clause(-5)).toBe("health score fell five points since the previous crawl");
    });
    it("says nothing about a change under a point", () => {
      expect(clause(-0.4)).toBeUndefined();
      expect(clause(0)).toBeUndefined();
    });
  });

  it("says page one in words, either way", () => {
    const full = rank.fixtures.full;
    const previous = { ...full.previous!, top10: 4 };
    const up = { ...full, previous, latest: { ...full.latest, top10: 6 } };
    const down = { ...full, previous, latest: { ...full.latest, top10: 3 } };
    expect(projectMoves(results({ rank: up })).map((m) => m.clause)).toContainEqual(expect.stringMatching(/^two more keywords are on page one than on /));
    expect(projectMoves(results({ rank: down })).map((m) => m.clause)).toContainEqual(expect.stringMatching(/^one fewer keyword is on page one than on /));
  });

  it("gets one AI answer and many right, and compares shares when prompts changed", () => {
    const { current, previous } = ai.fixtures.full;
    const one = { ...ai.fixtures.full, current: { ...current, cited: previous!.cited + 1 } };
    expect(projectMoves(results({ ai: one }))[0]).toMatchObject({ clause: "one more AI answer cites you than in the previous run", tone: "good" });
    const two = { ...ai.fixtures.full, current: { ...current, cited: previous!.cited - 2 } };
    expect(projectMoves(results({ ai: two }))[0]).toMatchObject({ clause: "two fewer AI answers cite you than in the previous run", tone: "bad" });
    const grown = { ...ai.fixtures.full, current: { ...current, total: current.total + 10, citedRate: previous!.citedRate! + 0.04 } };
    expect(projectMoves(results({ ai: grown }))[0].clause).toBe("the share of AI answers citing you rose 4 points since the previous run");
  });

  it("says a change in share to one decimal, the same as the figure beside it", () => {
    const { current, previous } = ai.fixtures.full;
    const rate = (citedRate: number) => ({ ...ai.fixtures.full, current: { ...current, total: current.total + 10, citedRate }, previous: { ...previous!, citedRate: 0.2 } });
    const risen = results({ ai: rate(0.245) });
    expect(projectMoves(risen)[0].clause).toBe("the share of AI answers citing you rose 4.5 points since the previous run");
    expect(figure(summarize(risen), "cited")).toMatchObject({ delta: { text: "+4.5 pts" } });
    const fallen = results({ ai: rate(0.155) });
    expect(projectMoves(fallen)[0].clause).toBe("the share of AI answers citing you fell 4.5 points since the previous run");
    expect(figure(summarize(fallen), "cited")).toMatchObject({ delta: { text: "−4.5 pts" } });
  });

  it("reads the same as the figure on a ratio that rounds differently done another way", () => {
    const { current, previous } = ai.fixtures.full;
    const rate = (now: number, before: number) => results({ ai: { ...ai.fixtures.full, current: { ...current, total: current.total + 10, citedRate: now }, previous: { ...previous!, citedRate: before } } });
    const risen = rate(1 / 2, 17 / 80);
    expect(projectMoves(risen)[0].clause).toBe("the share of AI answers citing you rose 28.7 points since the previous run");
    expect(figure(summarize(risen), "cited")).toMatchObject({ delta: { text: "+28.7 pts" } });
    const fallen = rate(17 / 80, 1 / 2);
    expect(projectMoves(fallen)[0].clause).toBe("the share of AI answers citing you fell 28.7 points since the previous run");
    expect(figure(summarize(fallen), "cited")).toMatchObject({ delta: { text: "−28.7 pts" } });
  });

  it("says nothing of a change in share that rounds to zero, as the figure says no change", () => {
    const { current, previous } = ai.fixtures.full;
    const still = results({ ai: { ...ai.fixtures.full, current: { ...current, total: current.total + 10, citedRate: 0.2004 }, previous: { ...previous!, citedRate: 0.2, score: current.score } } });
    expect(projectMoves(still)).toEqual([]);
    expect(figure(summarize(still), "cited")).toMatchObject({ delta: { text: "No change", tone: "muted" } });
  });

  it("ignores moves too small to say, and doesn't claim nothing moved beside a change on the card", () => {
    const r = results({ google: googleWith(1040, 1000) });
    expect(projectMoves(r)).toEqual([]);
    expect(figure(summarize(r), "clicks")).toMatchObject({ delta: { tone: "good" } });
    expect(projectSentence(r)).toBe("Only small changes against the last checks.");
  });

  it("gets a few clicks either way right", () => {
    const r = results({ google: googleWith(18, 14) });
    expect(figure(summarize(r), "clicks")).toMatchObject({ delta: { text: "+4", tone: "good" } });
    expect(projectSentence(r)).toBe("Only small changes against the last checks.");
  });

  describe("nothing moved", () => {
    const totals = { clicks: 1000, impressions: 40_000, ctr: 0.025, position: 12 };
    const flatGoogle = { ...google.fixtures.full, current: totals, previous: totals, series: [] };
    const flatAudit = { ...audit.fixtures.full, changes: { score: 0, errors: 0, warnings: 0, notices: 0, pagesWithErrors: 0 } };
    const { latest } = rank.fixtures.full;
    const flatRank = { ...rank.fixtures.full, previous: { ...latest, date: "2026-10-20" } };
    const SMALL = "Only small changes against the last checks.";

    it("says it when no number on the page shows a change", () => {
      expect(projectSentence(results({ google: flatGoogle }))).toBe("Nothing moved against the last checks.");
      expect(projectSentence(results({ audit: flatAudit }))).toBe("Nothing moved against the last checks.");
      expect(projectSentence(results({ rank: flatRank }))).toBe("Nothing moved against the last checks.");
    });

    it("doesn't say it when an audit's errors and warnings moved with the score and pages flat", () => {
      expect(projectSentence(results({ audit: { ...flatAudit, changes: { ...flatAudit.changes, errors: 10, warnings: 40 } } }))).toBe(SMALL);
      expect(projectSentence(results({ audit: { ...flatAudit, changes: { ...flatAudit.changes, notices: -3 } } }))).toBe(SMALL);
    });

    it("doesn't say it when clicks are flat and impressions rose", () => {
      expect(projectSentence(results({ google: { ...flatGoogle, current: { ...totals, impressions: 60_000 } } }))).toBe(SMALL);
    });

    it("doesn't say it when the 7-day clicks moved inside a flat 28 days", () => {
      const week = { ...flatGoogle, series: [{ date: flatGoogle.end, clicks: 5, position: 12 }] };
      expect(projectSentence(results({ google: week }))).toBe(SMALL);
    });

    it("doesn't say it when pages with errors, position or Top 3 moved", () => {
      expect(projectSentence(results({ audit: { ...flatAudit, changes: { ...flatAudit.changes, pagesWithErrors: 1 } } }))).toBe(SMALL);
      expect(projectSentence(results({ rank: { ...flatRank, previous: { ...flatRank.previous, avgPosition: (latest.avgPosition ?? 10) + 1 } } }))).toBe(SMALL);
      expect(projectSentence(results({ rank: { ...flatRank, previous: { ...flatRank.previous, top3: latest.top3 + 1 } } }))).toBe(SMALL);
    });

    it("isn't fooled by a change that rounds to nothing", () => {
      expect(projectSentence(results({ google: { ...flatGoogle, current: { ...totals, ctr: 0.02500001 } } }))).toBe("Nothing moved against the last checks.");
    });
  });

  it("says how many on page one aren't confirmed, out of how many, on the strip and on the card", () => {
    const { latest, previous } = rank.fixtures.full;
    const r = results({ rank: { ...rank.fixtures.full, latest: { ...latest, top10NotConfirmed: 9 }, previous: previous! } });
    const when = chartDay(previous!.date);
    expect(buildHeadlines(r, { gscConnected: false }).figures.find((f) => f.id === "page-one")).toMatchObject({ caption: `in the top 10, 9 of the 19 not confirmed, vs ${when}` });
    expect(figure(summarize(r), "page-one")).toMatchObject({ caption: `9 of the 19 not confirmed, vs ${when}` });
  });

  // The gain counts keywords that reached page one; the card counts all of page one. The words keep them apart.
  it("says how much of a page one gain isn't confirmed, as keywords that reached it", () => {
    const { latest, previous } = rank.fixtures.full;
    const data = { ...rank.fixtures.full, latest: { ...latest, top10: 80 }, previous: { ...previous!, top10: 60 } };
    const when = chartDay(previous!.date);
    const clause = (d: typeof data) => projectMoves(results({ rank: d })).find((m) => m.id === "page-one")?.clause;
    expect(clause(data)).toBe(`20 more keywords are on page one than on ${when}`);
    expect(clause({ ...data, pageOneGainsNotConfirmed: 6 })).toBe(`20 more keywords are on page one than on ${when}, counting 6 that reached it on positions not confirmed`);
    // A fall is already the cautious reading, so it needs no caveat.
    const fell = { ...data, latest: { ...latest, top10: 60 }, previous: { ...previous!, top10: 80 }, pageOneGainsNotConfirmed: 6 };
    expect(clause(fell)).toBe(`20 fewer keywords are on page one than on ${when}`);
  });

  describe("a page one gain that's all unconfirmed", () => {
    const { latest, previous } = rank.fixtures.full;
    const when = chartDay(previous!.date);
    const withGain = (was: number, now: number, unconfirmed: number) => ({ ...rank.fixtures.full, latest: { ...latest, top10: now }, previous: { ...previous!, top10: was }, pageOneGainsNotConfirmed: unconfirmed });
    const move = (d: ReturnType<typeof withGain>) => projectMoves(results({ rank: d })).find((m) => m.id === "page-one");

    it("isn't good news, and says so", () => {
      expect(move(withGain(60, 80, 20))).toMatchObject({ tone: "neutral", clause: `20 more keywords show on page one than on ${when}, with none of the gain confirmed` });
      // 25 came in unconfirmed and five fell off: the net gain is still all theirs.
      expect(move(withGain(60, 80, 25))).toMatchObject({ tone: "neutral" });
      expect(move(withGain(2, 3, 1))).toMatchObject({ tone: "neutral", clause: `one more keyword shows on page one than on ${when}, with none of the gain confirmed` });
    });

    it("keeps its good tone and its note when only part of the gain is unconfirmed", () => {
      expect(move(withGain(60, 80, 19))).toMatchObject({ tone: "good", clause: `20 more keywords are on page one than on ${when}, counting 19 that reached it on positions not confirmed` });
      expect(move(withGain(60, 80, 0))).toMatchObject({ tone: "good", clause: `20 more keywords are on page one than on ${when}` });
    });

    it("leaves a fall as it was", () => {
      expect(move(withGain(80, 60, 6))).toMatchObject({ tone: "bad", clause: `20 fewer keywords are on page one than on ${when}` });
    });

    it("shows the number in a neutral tone on the strip and the card, and doesn't list it as better in What changed", () => {
      const r = results({ rank: withGain(60, 80, 20) });
      const neutral = { text: "+20", tone: "muted", up: true };
      expect(buildHeadlines(r, { gscConnected: false }).figures.find((f) => f.id === "page-one")).toMatchObject({ delta: neutral });
      expect(figure(summarize(r), "page-one")).toMatchObject({ delta: neutral });
      expect(buildHeadlines(r, { gscConnected: false }).also.find((x) => x.label === "On page one")).toBeUndefined();
    });

    it("keeps the good tone on the strip and the card for a partial gain", () => {
      const r = results({ rank: withGain(60, 80, 19) });
      expect(buildHeadlines(r, { gscConnected: false }).figures.find((f) => f.id === "page-one")).toMatchObject({ delta: { text: "+20", tone: "good" } });
      expect(figure(summarize(r), "page-one")).toMatchObject({ delta: { text: "+20", tone: "good" } });
    });

    it("never raises the flag or reads as nothing having moved", () => {
      expect(summarize(results({ rank: withGain(60, 80, 20) }))).toMatchObject({ status: "steady", worst: 0 });
      const flat = { ...rank.fixtures.full, series: [], latest: { ...latest, visibility: 0.2, top3: 5, top10: 501, avgPosition: 12 }, previous: { ...previous!, visibility: 0.2, top3: 5, top10: 500, avgPosition: 12 }, pageOneGainsNotConfirmed: 1 };
      expect(projectSentence(results({ rank: flat }))).toBe("Only small changes against the last checks.");
    });

    it("reads as a plain sentence beside other moves, never as a counterpoint", () => {
      expect(projectSentence(results({ rank: withGain(60, 80, 20) }))).toBe(`20 more keywords show on page one than on ${when}, with none of the gain confirmed.`);
      const fell = googleWith(600, 1000);
      expect(projectSentence(results({ rank: withGain(60, 80, 20), google: fell }))).toBe(`Clicks are down 40% on the 28 days before, and 20 more keywords show on page one than on ${when}, with none of the gain confirmed.`);
    });
  });

  it("reads On page one the same on the strip, on the card and in What changed", () => {
    const { latest, previous } = rank.fixtures.full;
    const data = { ...rank.fixtures.full, latest: { ...latest, top10: 80 }, previous: { ...previous!, top10: 60 } };
    const r = results({ rank: data });
    const strip = buildHeadlines(r, { gscConnected: false }).figures.find((f) => f.id === "page-one");
    const also = buildHeadlines(r, { gscConnected: false }).also.find((x) => x.label === "On page one");
    expect(strip).toMatchObject({ delta: { text: "+20" } });
    expect(figure(summarize(r), "page-one")).toMatchObject({ delta: { text: "+20" } });
    expect(also).toMatchObject({ delta: { text: "+20" } });
  });

  it("says a small fall in passing, in numbers, and never leads with it over a real move", () => {
    expect(projectSentence(results({ ga4: ga4With(33, 39) }))).toBe("Only small changes: organic sessions are down from 39 to 33 on the 28 days before.");
    expect(projectSentence(results({ ga4: ga4With(33, 39), google: googleWith(1400, 1000) }))).toBe("Clicks are up 40% on the 28 days before.");
  });

  it("gives the two numbers on a small base, and a percentage above it", () => {
    expect(projectSentence(results({ ga4: ga4With(37, 14) }))).toBe("Organic sessions are up from 14 to 37 on the 28 days before.");
    expect(figure(summarize(results({ ga4: ga4With(37, 14) })), "sessions")).toMatchObject({ delta: { text: "+23" } });
    expect(projectSentence(results({ ga4: ga4With(60, 30) }))).toBe("Organic sessions are up from 30 to 60 on the 28 days before.");
    expect(projectSentence(results({ ga4: ga4With(90, 60) }))).toBe("Organic sessions are up 50% on the 28 days before.");
    expect(figure(summarize(results({ ga4: ga4With(90, 60) })), "sessions")).toMatchObject({ delta: { text: "+50%" } });
  });

  it("says a rise from nothing, and stays quiet on a few", () => {
    expect(projectSentence(results({ google: googleWith(30, 0) }))).toBe("Clicks are up from 0 to 30 on the 28 days before.");
    expect(projectSentence(results({ google: googleWith(600, 0) }))).toBe("Clicks are up from 0 to 600 on the 28 days before.");
    expect(projectSentence(results({ google: googleWith(3, 0) }))).toBe("Only small changes against the last checks.");
  });

  it("reports what moved on a project with only Local SEO or Domain analysis", () => {
    const sentence = projectSentence(results({ local: local.fixtures.full }));
    // On the same grid it counts points, as Local SEO's page does; a grid that changed size compares shares.
    expect(sentence).toMatch(/^Map points in the top 3 went from 35 to 45 of 125 since /);
    const grown = { ...local.fixtures.full, latest: { ...local.fixtures.full.latest, answered: 150 } };
    expect(projectSentence(results({ local: grown }))).toMatch(/^The share of map points in the top 3 rose 8 points since /);
    expect(sentence).toContain("average map rank went from 5.1 to 4.2");
    const cur = { date: "2026-11-02", keywords: 1300, traffic: 5000, top10: 40, trafficValue: 900 };
    const prev = { month: "2026-10", keywords: 1250, traffic: 4000, top10: 40 };
    const domain = { domain: "a.com", latest: cur, previous: prev, history: [] };
    expect(projectSentence(results({ domains: domain }))).toBe("Estimated visits are up 25% since Oct 2026.");
    expect(projectSentence(results({ domains: { ...domain, latest: { ...cur, traffic: 3000, top10: 30 } } }))).toBe("Estimated visits are down 25% since Oct 2026, and 10 fewer keywords are in the top 10 than in Oct 2026.");
    expect(projectSentence(results({ domains: { ...domain, latest: { ...cur, traffic: 5000, top10: 50 } } }))).toBe("Estimated visits are up 25% since Oct 2026, and 10 more keywords are in the top 10 than in Oct 2026.");
  });

  it("calls a small move in those modules small, not a first reading", () => {
    const small = { domain: "a.com", latest: { date: "2026-11-02", keywords: 1000, traffic: 1000, top10: 40, trafficValue: 0 }, previous: { month: "2026-10", keywords: 1010, traffic: 1000, top10: 40 }, history: [] };
    expect(projectSentence(results({ domains: small }))).toBe("Only small changes against the last checks.");
    expect(summarize(results({ domains: small })).compared).toBe(true);
  });

  it("still has first readings when those modules have only one check", () => {
    expect(projectSentence(results({ local: { ...local.fixtures.full, previous: null } }))).toBe("First readings are in. Changes show from the next check.");
    expect(summarize(results({ local: { ...local.fixtures.full, previous: null } })).compared).toBe(false);
  });

  it("leaves those modules out once the six numbers can be compared, and never flags a project over them", () => {
    const data = { google: googleWith(1000, 1000), local: { ...local.fixtures.full, latest: { ...local.fixtures.full.latest, avgRank: 9 } } };
    expect(projectSentence(results(data))).not.toContain("map");
    expect(summarize(results({ local: { ...local.fixtures.full, latest: { ...local.fixtures.full.latest, avgRank: 9 } } })).worst).toBe(0);
  });

  it("says a crawl is running with no results yet, not that first readings are in", () => {
    const crawling = { timeZone: "UTC", latest: null, previous: null, changes: null, running: { pagesCrawled: 3, maxPages: 500 } };
    expect(projectSentence(results({ audit: crawling }))).toBe("A crawl is running. Results show when it finishes.");
    expect(summarize(results({ audit: crawling }))).toMatchObject({ status: "waiting", live: 0 });
  });

  it("has a first-readings sentence with nothing earlier", () => {
    expect(projectSentence(results({ google: googleWith(1040, null) }))).toBe("First readings are in. Changes show from the next check.");
  });

  it("finds the worst clause", () => {
    expect(worstClause(results({ google: googleWith(600, 1000) }))).toBe("clicks are down 40% on the 28 days before");
    expect(worstClause(results({ google: googleWith(1400, 1000) }))).toBeUndefined();
  });
});

describe("clicksSpark", () => {
  const days = (n: number, at: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ date: addDays("2026-10-27", i - (n - 1)), value: at(i) }));

  it("names a line by what it covers", () => {
    expect(clicksSpark(days(28, (i) => 40 + (i % 7) * 6))?.label).toBe("Clicks, 28 days");
    expect(clicksSpark(days(5, (i) => 40 + i))?.label).toBe("Clicks, 5 days");
  });
  it("adds few clicks up by week, and says so", () => {
    const spark = clicksSpark(days(28, (i) => i % 3));
    expect(spark?.label).toBe("Clicks, 28 days, by week");
    expect(spark?.points).toHaveLength(4);
  });
  it("draws nothing, so captions nothing, without a trend", () => {
    expect(clicksSpark([])).toBeNull();
    expect(clicksSpark(days(28, () => 5))).toBeNull();
    expect(clicksSpark(days(10, (i) => (i === 0 ? 9 : 0)))).toBeNull();
  });
});

describe("boardSentence", () => {
  const entry = (name: string, status: "attention" | "steady" | "waiting" | "empty", worst = 0, worstClause?: string, compared = true) => ({ name, summary: { status, worst, compared }, worstClause });
  const first = (name: string) => entry(name, "steady", 0, undefined, false);

  it("says a project is set up and waiting, not that nothing is set up", () => {
    expect(boardSentence([entry("A", "waiting", 0, undefined, false), entry("B", "empty")])).toBe("A is set up and waiting for its first results.");
    expect(boardSentence([entry("A", "waiting"), entry("B", "waiting")])).toBe("Two projects are set up and waiting for their first results.");
  });

  it("adds the waiting ones after what the live ones say, counting only the live ones as live", () => {
    expect(boardSentence([entry("A", "steady"), entry("B", "waiting")])).toBe("Your one live project looks steady against its last checks. Another is set up and waiting for its first results.");
    expect(boardSentence([entry("A", "attention", 0.2, "clicks are down 20%"), entry("B", "waiting"), entry("C", "waiting")])).toBe("A needs a look: clicks are down 20%. Two others are set up and waiting for their first results.");
  });

  it("names the most urgent project", () => {
    expect(boardSentence([entry("A", "attention", 0.2, "clicks are down 20%"), entry("B", "attention", 0.5, "site health fell 5 points"), entry("C", "steady")])).toBe("Two projects need a look. Most of all B: site health fell 5 points.");
  });

  it("gets one project right", () => {
    expect(boardSentence([entry("A", "attention", 0.2, "clicks are down 20%"), entry("C", "steady")])).toBe("One project needs a look. Most of all A: clicks are down 20%.");
  });

  it("says all steady, counting only what's set up", () => {
    expect(boardSentence([entry("A", "steady"), entry("B", "steady"), entry("C", "empty")])).toBe("All two projects look steady against their last checks.");
  });

  it("copes with a failure that has no clause, and with nothing set up", () => {
    expect(boardSentence([entry("A", "attention"), entry("B", "steady")])).toBe("One project needs a look.");
    expect(boardSentence([entry("A", "empty")])).toBe("Nothing is set up yet. Open a project to start.");
    expect(boardSentence([])).toBe("Nothing is set up yet. Open a project to start.");
  });

  it("gets one live project right, in the singular", () => {
    expect(boardSentence([entry("A", "steady")])).toBe("Your one live project looks steady against its last checks.");
    expect(boardSentence([entry("A", "steady"), entry("B", "empty")])).toBe("Your one live project looks steady against its last checks.");
  });

  it("names one live project that needs a look, with no one to rank it against", () => {
    expect(boardSentence([entry("A", "attention", 0.2, "clicks are down 20%")])).toBe("A needs a look: clicks are down 20%.");
    expect(boardSentence([entry("A", "attention"), entry("B", "empty")])).toBe("A needs a look.");
  });

  it("claims no comparison when there's no last check", () => {
    expect(boardSentence([first("A")])).toBe("Your one live project has only first readings. Changes show from the next check.");
    expect(boardSentence([first("A"), first("B")])).toBe("All two projects have only first readings. Changes show from the next check.");
  });

  it("says steady only of the projects that had a last check", () => {
    expect(boardSentence([entry("A", "steady"), first("B")])).toBe("One of two projects looks steady against its last checks. The other has only first readings.");
    expect(boardSentence([entry("A", "steady"), entry("B", "steady"), first("C")])).toBe("Two of three projects look steady against their last checks. The other has only first readings.");
    expect(boardSentence([entry("A", "steady"), first("B"), first("C")])).toBe("One of three projects looks steady against its last checks. The others have only first readings.");
  });

  it("reads whether a project compared from its results", () => {
    expect(summarize(results({ google: googleWith(1040, 1000) })).compared).toBe(true);
    expect(summarize(results({ google: googleWith(1040, null) })).compared).toBe(false);
    expect(summarize(results([])).compared).toBe(false);
  });
});

describe("projectIdFromPath", () => {
  it("reads the project from its dashboard and settings URLs only", () => {
    expect(projectIdFromPath("/projects/12")).toBe("12");
    expect(projectIdFromPath("/projects/12/settings")).toBe("12");
    expect(projectIdFromPath("/projects/new")).toBeNull();
    expect(projectIdFromPath("/projects")).toBeNull();
    expect(projectIdFromPath("/projects/12abc")).toBeNull();
    expect(projectIdFromPath("/rank")).toBeNull();
  });
});

describe("a source whose newest check failed", () => {
  const checkFailed = failedCheck({ noun: "check", at: new Date("2026-11-07T12:00:00Z"), timeZone: "UTC", reason: "None of this check's searches came back.", retry: true, next: { label: "View", href: "/rank" } });
  const crawlFailed = failedCheck({ noun: "crawl", at: new Date("2026-11-07T12:00:00Z"), timeZone: "UTC", reason: "The crawl stopped.", retry: true, next: { label: "View", href: "/audit" } });
  const reconnect: CheckFailure = { kind: "reconnect", noun: "sync", at: null, day: null, reason: "Why.", retry: false, next: { label: "Reconnect", href: "/gsc" }, provider: "Google" };
  const failing = (list: ModuleResult[], failures: Record<string, CheckFailure>) => list.map((r): ModuleResult => (failures[r.module.id] ? { ...r, lastRunFailed: failures[r.module.id] } : r));
  // Identical readings, so without the failure this project has only small changes or none.
  const flat = { rank: { ...rank.fixtures.full, previous: rank.fixtures.full.latest }, audit: { ...audit.fixtures.full, changes: null } };

  it("doesn't say small changes, nothing moved or first readings", () => {
    const list = failing(results(flat), { rank: checkFailed });
    const said = projectSentence(list);
    expect(said).toBe("Rankings need a look: the last check failed on Nov 7.");
    expect(said).not.toMatch(/small changes|Nothing moved|First readings|steady|waiting/i);
  });

  it("names every failing source in one line, and keeps what the healthy ones moved", () => {
    expect(projectSentence(failing(results(flat), { rank: checkFailed, audit: crawlFailed }))).toBe("Rankings and Site audit need a look: their latest checks failed.");
    const said = projectSentence(failing(results(["google", "rank"]), { rank: checkFailed }));
    expect(said).toMatch(/^Rankings need a look: the last check failed on Nov 7\. Clicks/);
  });

  it("doesn't report what a failing source moved as news", () => {
    const { latest } = rank.fixtures.full;
    const fell = results({ rank: { ...rank.fixtures.full, previous: { ...latest, top10: latest.top10 + 20 } } });
    expect(summarize(fell).biggest).toBeGreaterThan(0);
    expect(worstClause(fell)).toMatch(/fewer keywords/);
    const list = failing(fell, { rank: checkFailed });
    expect(projectSentence(list)).toBe("Rankings need a look: the last check failed on Nov 7.");
    expect(summarize(list).biggest).toBe(0);
    expect(summarize(list).worst).toBe(0);
    expect(worstClause(list)).toBe("the last Rankings check failed on Nov 7");
  });

  it("flags the project, even with nothing else loaded, so it isn't listed as waiting", () => {
    const list = failing(
      results({}).map((r): ModuleResult => (r.status === "empty" && r.module.id === "rank" ? { ...r, waiting: "8 keywords tracked, waiting for the first check" } : r)),
      { rank: checkFailed },
    );
    const s = summarize(list);
    expect(s.status).toBe("attention");
    expect(s.looking).toBe(1);
    expect(s.sentence).toBe("Rankings need a look: the last check failed on Nov 7.");
    expect(s.sentence).not.toMatch(/waiting/);
  });

  it("says the failure in the figure, in place of waiting or not set up", () => {
    const figures = Object.fromEntries(summarize(failing(results({}), { rank: checkFailed, audit: crawlFailed, google: reconnect })).figures.map((f) => [f.id, f]));
    expect(figures["page-one"]).toMatchObject({ state: "empty", text: "Last check failed Nov 7", tone: "bad" });
    expect(figures.health).toMatchObject({ state: "empty", text: "Last crawl failed Nov 7", tone: "bad" });
    expect(figures.clicks).toMatchObject({ state: "empty", text: "Reconnect Google", tone: "bad" });
    expect(figures.cited).toMatchObject({ state: "empty", text: "Not set up" });
  });

  it("keeps an older number, labelled with its date", () => {
    const figures = Object.fromEntries(summarize(failing(results(["rank", "google"]), { rank: checkFailed, google: reconnect })).figures.map((f) => [f.id, f]));
    expect(figures["page-one"].state).toBe("value");
    expect(figures["page-one"].caption).toMatch(/Last check failed Nov 7\.$|From .+, last check failed Nov 7\.$/);
    expect(figures.clicks.caption).toMatch(/Reconnect Google to update\.$/);
  });

  it("counts on the board, ahead of a steady project", () => {
    const quiet = results(flat);
    const stuck = failing(results(flat), { rank: checkFailed });
    const entry = (name: string, list: ModuleResult[]) => ({ name, summary: summarize(list), worstClause: worstClause(list) });
    expect(boardSentence([entry("Calm", quiet), entry("Stuck", stuck)])).toBe("One project needs a look. Most of all Stuck: the last Rankings check failed on Nov 7.");
    expect(boardSentence([entry("One", stuck), entry("Two", failing(results(flat), { google: reconnect, audit: crawlFailed }))])).toMatch(/^Two projects need a look\./);
    expect(worstClause(failing(results(flat), { google: reconnect }))).toBe("Google needs reconnecting");
  });

  it("clears with the failure: a project with none reads as before", () => {
    expect(summarize(results(flat)).looking).toBe(0);
    expect(summarize(results(flat)).status).toBe("steady");
    expect(projectSentence(results(flat))).not.toMatch(/needs? a look/);
  });
});

describe("an Analytics source whose data stopped arriving", () => {
  const stopped = stoppedData({ at: new Date("2026-11-06T12:00:00Z"), timeZone: "UTC", since: "2026-10-01", reason: "SEOpen asked GA4 for every day through Nov 6, and the newest day with organic sessions is Oct 1.", next: { label: "View", href: "/ga4" } });
  // One client site's shape: 0 sessions, then 3, over a window that ended five weeks ago.
  const quiet = { ...ga4.fixtures.full, end: "2026-10-01", current: { ...ga4.fixtures.full.current, sessions: 3 }, previous: { ...ga4.fixtures.full.previous!, sessions: 0 } };
  const list = results({ ga4: quiet }).map((r): ModuleResult => (r.module.id === "ga4" ? { ...r, lastRunFailed: stopped } : r));

  it("flags the project and says the day the data stopped", () => {
    const s = summarize(list);
    expect(s.status).toBe("attention");
    expect(s.looking).toBe(1);
    expect(s.sentence).toBe("Analytics still syncs, but no data has arrived since Oct 1.");
    expect(worstClause(list)).toBe("no Analytics data has arrived since Oct 1");
  });

  it("keeps the number but takes the good tone off its change, and says it synced with nothing newer", () => {
    const f = figure(summarize(list), "sessions");
    expect(f.state).toBe("value");
    if (f.state !== "value") return;
    expect(f.delta?.tone).toBe("muted");
    expect(f.caption).toBe("28 days to Oct 1. Synced Nov 6 with nothing newer.");
    // Without the failure the same numbers read as better.
    const healthy = figure(summarize(results({ ga4: quiet })), "sessions");
    expect(healthy.state === "value" && healthy.delta?.tone).toBe("good");
  });
});
