import { describe, expect, it } from "vitest";
import { CHANGES_NOTE, competitorsFigures, competitorsSentence, domainFigures, domainSentence, gapFigures, gapSentence, keywordsFigures, keywordsSentence, monthBefore, pagesFigures, pagesSentence, type ViewCounts } from "./brief";
import type { CompetitorRow, GapTab, HistoryPoint, PageRow } from "./transform";
import type { OrganicMetrics } from "./types";

const READ = new Date("2026-10-29T12:00:00Z");

describe("CHANGES_NOTE", () => {
  it("says the new and lost counts cover a different window from the month-on-month figures", () => {
    expect(CHANGES_NOTE).toBe("Counted from our index's last update. The changes at the top of the page compare months, so the two won't add up.");
  });
});

const organic = (over: Partial<OrganicMetrics> = {}): OrganicMetrics => ({
  pos_1: 1,
  pos_2_3: 2,
  pos_4_10: 3,
  pos_11_20: 4,
  pos_21_30: 0,
  pos_31_40: 0,
  pos_41_50: 0,
  pos_51_60: 0,
  pos_61_70: 0,
  pos_71_80: 0,
  pos_81_90: 0,
  pos_91_100: 0,
  etv: 1000,
  count: 500,
  estimated_paid_traffic_cost: 250,
  is_new: 0,
  is_up: 0,
  is_down: 0,
  is_lost: 0,
  ...over,
});

const month = (date: string, traffic: number, keywords: number, top10 = 6): HistoryPoint => ({ date, traffic, keywords, top10 });

describe("monthBefore", () => {
  const history = [month("2026-08", 700, 500), month("2026-09", 800, 500), month("2026-10", 1000, 500)];

  it("skips the month it was read in, and the months after", () => {
    expect(monthBefore(history, new Date("2026-10-29T12:00:00Z"))?.date).toBe("2026-09");
  });

  it("takes the newest month when the history stops short of the month it was read in", () => {
    expect(monthBefore(history, new Date("2026-11-07T12:00:00Z"))?.date).toBe("2026-10");
  });

  it("has nothing to compare with when no earlier month is stored", () => {
    expect(monthBefore([], new Date("2026-11-07T12:00:00Z"))).toBeUndefined();
    expect(monthBefore(null, new Date("2026-11-07T12:00:00Z"))).toBeUndefined();
    expect(monthBefore([month("2026-11", 1000, 500)], new Date("2026-11-07T12:00:00Z"))).toBeUndefined();
  });
});

describe("domainSentence", () => {
  it("leads on a move up against the month before", () => {
    expect(domainSentence("a.com", organic(), [month("2026-09", 800, 500), month("2026-10", 1000, 500)], READ)).toBe("Estimated clicks are up 25%, compared with Sep 2026.");
  });

  it("puts a fall first and still names the rise", () => {
    expect(domainSentence("a.com", organic({ etv: 500, count: 500 }), [month("2026-09", 1000, 400), month("2026-10", 500, 500)], READ)).toBe("Estimated clicks are down 50%, but ranking keywords are up 25%, compared with Sep 2026.");
  });

  it("falls back to the last update when the month moved too little to say", () => {
    const history = [month("2026-09", 990, 500), month("2026-10", 1000, 500)];
    expect(domainSentence("a.com", organic({ is_new: 1, is_up: 1, is_down: 1 }), history, READ)).toBe("Since the last update, two keywords are new or moved up, and one moved down or dropped out.");
    expect(domainSentence("a.com", organic({ is_up: 1 }), history, READ)).toBe("Since the last update, one keyword is new or moved up.");
    expect(domainSentence("a.com", organic({ is_lost: 1 }), history, READ)).toBe("Since the last update, one keyword moved down or dropped out.");
  });

  it("doesn't dress up a move on small counts", () => {
    expect(domainSentence("a.com", organic({ etv: 5, count: 8 }), [month("2026-09", 3, 7), month("2026-10", 5, 8)], READ)).toBe("Nothing moved since the last update.");
  });

  it("is calm when nothing moved", () => {
    expect(domainSentence("a.com", organic(), [month("2026-09", 1000, 500), month("2026-10", 1000, 500)], READ)).toBe("Nothing moved since the last update.");
  });

  it("doesn't claim a first look when the history isn't loaded", () => {
    expect(domainSentence("a.com", organic(), null, READ)).toBe("Nothing moved since the last update.");
  });

  it("says when there's nothing earlier", () => {
    expect(domainSentence("a.com", organic(), [], READ)).toBe("First look at a.com. Changes show after the next update.");
    expect(domainSentence("a.com", organic(), [month("2026-10", 1000, 500)], READ)).toBe("First look at a.com. Changes show after the next update.");
  });
});

describe("the month it compares with", () => {
  const history = [month("2026-08", 700, 500, 3), month("2026-09", 800, 500, 3), month("2026-10", 900, 500, 12)];
  const NOV = new Date("2026-11-07T12:00:00Z");

  it("is the last finished month when the history stops before the month it's read in", () => {
    const [traffic, , top10] = domainFigures(organic({ etv: 1000 }), history, NOV);
    expect(traffic).toMatchObject({ caption: "clicks from Google, vs Oct 2026" });
    expect(top10).toMatchObject({ caption: "1% of all, vs Oct 2026" });
    expect(domainSentence("a.com", organic({ etv: 1500 }), history, NOV)).toBe("Estimated clicks are up 67%, compared with Oct 2026.");
  });

  it("skips the month it's read in when the history has reached it", () => {
    expect(domainFigures(organic(), [...history, month("2026-11", 1000, 500)], NOV)[0]).toMatchObject({ caption: "clicks from Google, vs Oct 2026" });
  });
});

describe("domainFigures", () => {
  it("compares with the month before", () => {
    const [traffic, keywords, top10, worth] = domainFigures(organic(), [month("2026-09", 800, 500, 3), month("2026-10", 1000, 500)], READ);
    expect(traffic).toMatchObject({ value: "1,000", delta: { tone: "good" }, caption: "clicks from Google, vs Sep 2026" });
    expect(keywords).toMatchObject({ value: "500", caption: "3 in the top 3, vs Sep 2026" });
    expect(top10).toMatchObject({ value: "6", delta: { text: "+3" }, caption: "1% of all, vs Sep 2026" });
    expect(worth).toMatchObject({ value: "$250", delta: null, caption: "what the clicks would cost as ads" });
  });

  it("shows a small count's change as a plain difference", () => {
    const [traffic] = domainFigures(organic({ etv: 3 }), [month("2026-09", 5, 500), month("2026-10", 3, 500)], READ);
    expect(traffic).toMatchObject({ value: "3", delta: { text: "−2", tone: "bad" } });
  });

  it("doesn't claim no earlier months when the history isn't loaded", () => {
    const [traffic, keywords, top10] = domainFigures(organic(), null, READ);
    expect(traffic).toMatchObject({ delta: null, caption: "clicks from Google" });
    expect(`${keywords.caption} ${top10.caption}`).not.toContain("no earlier");
  });

  it("has no change with nothing earlier", () => {
    for (const f of domainFigures(organic(), [], READ)) expect(f).toMatchObject({ state: "value", delta: null });
    expect(domainFigures(organic(), [], READ)[0]).toMatchObject({ caption: "clicks from Google, no earlier monthly total" });
  });
});

const counts = (over: Partial<ViewCounts> = {}): ViewCounts => ({ all: 10, new: 0, improved: 0, declined: 0, lost: 0, ...over });

describe("keywordsSentence", () => {
  it("says what moved up and what moved down", () => {
    expect(keywordsSentence("a.com", counts({ new: 1, improved: 11, declined: 2, lost: 1 }))).toBe("Since the last update, 12 keywords are new or moved up, and three moved down or dropped out.");
    expect(keywordsSentence("a.com", counts({ improved: 1 }))).toBe("Since the last update, one keyword is new or moved up.");
    expect(keywordsSentence("a.com", counts({ declined: 2 }))).toBe("Since the last update, two keywords moved down or dropped out.");
  });

  it("names the page when filtered to one", () => {
    expect(keywordsSentence("a.com", counts({ lost: 1 }), true)).toBe("On this page, since the last update, one keyword moved down or dropped out.");
    expect(keywordsSentence("a.com", counts(), true)).toBe("Nothing moved on this page since the last update.");
  });

  it("is calm when nothing moved", () => {
    expect(keywordsSentence("a.com", counts())).toBe("Nothing moved since the last update.");
  });

  it("says so when there are no rows at all", () => {
    expect(keywordsSentence("a.com", counts({ all: 0 }))).toBe("None of the keywords loaded rank for a.com yet.");
    expect(keywordsSentence("a.com", counts({ all: 0 }), true)).toBe("None of the keywords loaded rank on this page.");
  });
});

describe("keywordsFigures", () => {
  it("counts what's loaded and links the moves to their views", () => {
    const [ranking, traffic, up, down] = keywordsFigures({ counts: counts({ new: 2, improved: 3, declined: 1, lost: 4 }), traffic: 12.6, loaded: 500, total: 1200, links: { up: "/up", down: "/down" } });
    expect(ranking).toMatchObject({ value: "10", caption: "from 500 of 1,200 rows, the highest traffic first" });
    expect(traffic).toMatchObject({ value: "13" });
    expect(up).toMatchObject({ value: "5", href: "/up", caption: "2 new, 3 improved" });
    expect(down).toMatchObject({ value: "5", href: "/down", caption: "1 declined, 4 lost" });
  });
});

const page = (path: string, traffic: number, share: number, trafficValue: number | null = 0) => ({ path, traffic, share, trafficValue }) as PageRow;

describe("pages", () => {
  it("says where the traffic sits", () => {
    const rows = [page("/d", 5, 0.05), page("/a", 50, 0.5), page("/b", 25, 0.25), page("/c", 20, 0.2)];
    expect(pagesSentence("a.com", rows)).toBe("The top three pages bring 95% of the estimated traffic across the four pages loaded.");
    expect(pagesFigures(rows, 40)[2]).toMatchObject({ label: "Top page", value: "50%", caption: "of the traffic: /a" });
  });

  it("gets small lists right", () => {
    expect(pagesSentence("a.com", [page("/a", 6, 0.6), page("/b", 4, 0.4)])).toBe("The top page brings 60% of the estimated traffic across the two pages loaded.");
    expect(pagesSentence("a.com", [page("/a", 6, 1)])).toBe("One page brings all the estimated traffic.");
    expect(pagesSentence("a.com", [page("/a", 0, 0), page("/b", 0, 0)])).toBe("None of the two pages loaded has any estimated traffic yet.");
  });

  it("adds up the priced pages and says how many have no CPC data", () => {
    const rows = [page("/a", 50, 0.5, 120.4), page("/services/seo/", 28, 0.28, null), page("/b", 22, 0.22, 10)];
    expect(pagesFigures(rows, 3)[3]).toMatchObject({ label: "Traffic value", value: "$130", caption: "what the clicks would cost as ads. One page has no CPC data" });
    expect(pagesFigures([page("/a", 50, 1, 12)], 1)[3]).toMatchObject({ caption: "what the clicks would cost as ads" });
  });

  it("has nothing to show without pages", () => {
    expect(pagesSentence("a.com", [])).toBe("No pages with organic traffic found for a.com.");
    expect(pagesFigures([], 0)).toEqual([]);
  });
});

const rival = (domain: string, common: number, overlap: number, traffic: number) => ({ domain, common, overlap, traffic, keywords: 100, avgPosition: 12 }) as CompetitorRow;

describe("competitors", () => {
  const rows = [rival("b.com", 1204, 0.34, 90), rival("c.com", 300, 0.5, 900)];

  it("names the closest and the biggest", () => {
    expect(competitorsSentence("a.com", rows)).toBe("b.com shares the most keywords with a.com: 1,204 keywords, 34% of a.com's.");
    const [found, common, overlap, traffic] = competitorsFigures(rows, 50, "/domains");
    expect(found).toMatchObject({ value: "2", caption: "of 50, the most keywords in common first" });
    expect(common).toMatchObject({ value: "1,204", caption: "keywords, b.com" });
    expect(overlap).toMatchObject({ value: "50%", caption: "of the keywords, c.com" });
    expect(traffic).toMatchObject({ value: "900", caption: "clicks a month, c.com" });
  });

  it("uses words for a small count and leaves out an unknown overlap", () => {
    expect(competitorsSentence("a.com", [rival("b.com", 2, 0, 5)])).toBe("b.com shares the most keywords with a.com: two keywords.");
    expect(competitorsFigures([rival("b.com", 2, 0, 5)], 1, "/domains?q=a.com")[2]).toMatchObject({ state: "empty", action: { href: "/domains?q=a.com" } });
  });

  it("has nothing to show without competitors", () => {
    expect(competitorsSentence("a.com", [])).toBe("No organic competitors found for a.com in this market.");
    expect(competitorsFigures([], 0, "/domains")).toEqual([]);
  });
});

const gap = (over: Partial<Record<GapTab, number>> = {}): Record<GapTab, number> => ({ shared: 0, missing: 0, weak: 0, strong: 0, untapped: 0, unique: 0, all: 10, ...over });

describe("gap", () => {
  it("says what's missing and what's ahead", () => {
    expect(gapSentence(["a.com", "b.com"], gap({ missing: 340, strong: 2 }))).toBe("a.com doesn't rank for 340 keywords that b.com ranks for, and ranks above b.com on two.");
    expect(gapSentence(["a.com", "b.com", "c.com"], gap({ missing: 1, strong: 12 }))).toBe("a.com doesn't rank for one keyword that all the others rank for, and ranks above them on 12.");
  });

  it("covers one side only", () => {
    expect(gapSentence(["a.com", "b.com"], gap({ missing: 2 }))).toBe("a.com doesn't rank for two keywords that b.com ranks for.");
    expect(gapSentence(["a.com", "b.com"], gap({ strong: 1 }))).toBe("a.com ranks above b.com on one keyword and isn't missing any.");
  });

  it("doesn't call a keyword only some of the others rank for not missing", () => {
    const domains = ["a.com", "b.com", "c.com"];
    expect(gapSentence(domains, gap({ strong: 40, untapped: 2000 }))).toBe("a.com ranks above all the others on 40 keywords and isn't missing any they all rank for, but at least one of them ranks for 2,000 keywords a.com doesn't.");
    expect(gapSentence(domains, gap({ strong: 40 }))).toBe("a.com ranks above all the others on 40 keywords and isn't missing any they all rank for.");
    expect(gapSentence(domains, gap({ untapped: 1 }))).toBe("a.com isn't missing any keywords all the others rank for and doesn't lead on any, but at least one of them ranks for one keyword a.com doesn't.");
  });

  it("is calm when nothing stands out, and honest with no data", () => {
    expect(gapSentence(["a.com", "b.com"], gap())).toBe("Nothing stands out: a.com isn't missing any keywords b.com ranks for, and doesn't lead on any.");
    expect(gapSentence(["a.com", "b.com"], gap({ all: 0 }))).toBe("None of these domains have keywords loaded to compare.");
  });

  it("links each figure to its tab", () => {
    const figures = gapFigures(gap({ missing: 3, weak: 1 }), (t) => `/gap?tab=${t}`);
    expect(figures.map((f) => f.label)).toEqual(["Missing", "Weak", "Strong", "Unique"]);
    expect(figures[0]).toMatchObject({ value: "3", href: "/gap?tab=missing", caption: "All the others rank, you don't" });
  });
});
