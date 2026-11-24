import { describe, expect, it } from "vitest";
import { rules } from "@/plan-policy/rules";
import {
  anchorsFigures,
  anchorsSentence,
  domainsFigures,
  domainSpamRow,
  domainsSentence,
  freshnessOf,
  gapFigures,
  gapHiddenNote,
  gapSentence,
  linksFigures,
  linksSentence,
  loadPromptText,
  monthSentence,
  monthSpan,
  newDomainSpam,
  overviewFigures,
  overviewFreshness,
  overviewSentence,
  readingBefore,
  readingDay,
  reviewFigures,
  reviewSentence,
  spamVerdict,
  type DomainFacts,
  type LinkFacts,
  type LinkReading,
} from "./brief";
import { columnsWithData, filterHref, type NewLostPoint } from "./logic";

const reading = (date: string, over: Partial<LinkReading> = {}): LinkReading => ({ date, backlinks: 1000, referringDomains: 100, rank: 200, spamScore: 10, ...over });

const OCT = reading("2026-10-28");
const REVIEW = "/backlinks/toxic?q=example.com";
const valueOf = (f: ReturnType<typeof overviewFigures>[number]) => (f.state === "value" ? f : null);

describe("overviewSentence", () => {
  it("says when this is the first reading", () => {
    expect(overviewSentence(reading("2026-11-04"), null)).toBe("First reading on Nov 4. Changes show after the next one.");
  });

  it("names a move up", () => {
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 120 }), OCT)).toBe("Referring domains are up 20%, compared with Oct 28.");
  });

  it("names a move down", () => {
    expect(overviewSentence(reading("2026-11-04", { backlinks: 800 }), OCT)).toBe("Backlinks are down 20%, compared with Oct 28.");
  });

  it("puts the fall first when one is up and one is down", () => {
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 130, backlinks: 900 }), OCT)).toBe("Backlinks are down 10%, but referring domains are up 30%, compared with Oct 28.");
  });

  it("says the numbers for a small count, not a percentage", () => {
    const small = reading("2026-10-28", { referringDomains: 5, backlinks: 12 });
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 7, backlinks: 12 }), small)).toBe("Referring domains went from 5 to 7, compared with Oct 28.");
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 3, backlinks: 12 }), small)).toBe("Referring domains went from 5 to 3, compared with Oct 28.");
  });

  it("is calm when nothing moved or the move is too small to matter", () => {
    expect(overviewSentence(reading("2026-11-04"), OCT)).toBe("Nothing moved since Oct 28.");
    expect(overviewSentence(reading("2026-11-04", { backlinks: 1020 }), OCT)).toBe("Referring domains and backlinks barely moved since Oct 28.");
    expect(overviewSentence(reading("2026-11-04", { backlinks: 1001 }), OCT)).toBe("Referring domains and backlinks barely moved since Oct 28.");
  });

  it("doesn't call a rise good when most of the new domains score high for spam, and says how many", () => {
    const spam = { fresh: 12, high: 9 };
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 115 }), OCT, spam)).toBe(
      "Referring domains are up 15%, compared with Oct 28, but 9 of the 12 domains new since then have a high spam score (60 or more).",
    );
    // Most aren't spam, or the count fell: the sentence is as before.
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 115 }), OCT, { fresh: 12, high: 6 })).toBe("Referring domains are up 15%, compared with Oct 28.");
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 85 }), OCT, spam)).toBe("Referring domains are down 15%, compared with Oct 28.");
  });

  it("counts from nothing without a percentage", () => {
    expect(overviewSentence(reading("2026-11-04", { referringDomains: 40 }), reading("2026-10-28", { referringDomains: 0 }))).toBe("Referring domains went from 0 to 40, compared with Oct 28.");
  });
});

describe("readingBefore", () => {
  it("takes the newest reading before the date, never the date itself", () => {
    const rows = [{ date: "2026-10-21" }, { date: "2026-10-28" }, { date: "2026-11-04" }];
    expect(readingBefore(rows, "2026-11-04")).toEqual({ date: "2026-10-28" });
    expect(readingBefore(rows, "2026-10-21")).toBeNull();
  });
});

describe("monthSentence", () => {
  const point = (over: Partial<NewLostPoint> = {}): NewLostPoint => ({ date: "2026-11", newDomains: 0, lostDomains: 0, newBacklinks: 0, lostBacklinks: 0, ...over });

  it("says what the latest month gained and lost", () => {
    expect(monthSentence([point({ date: "2026-10", newDomains: 9 }), point({ newDomains: 2, lostDomains: -1 })])).toBe("Two new referring domains and one lost in Nov 2026.");
    expect(monthSentence([point({ newDomains: 1 })])).toBe("One new referring domain in Nov 2026.");
    expect(monthSentence([point({ lostDomains: -12 })])).toBe("12 referring domains lost in Nov 2026.");
  });

  it("is calm with nothing on record", () => {
    expect(monthSentence([point()])).toBe("No referring domains gained or lost in Nov 2026.");
    expect(monthSentence([])).toBe("No new or lost referring domains on record.");
  });
});

describe("overviewFigures", () => {
  it("shows moves as deltas and says what they compare against", () => {
    const [domains, backlinks, rank, spam] = overviewFigures(reading("2026-11-04", { referringDomains: 120, backlinks: 1000, rank: 210, spamScore: 12 }), OCT, true, REVIEW);
    expect(domains).toMatchObject({ value: "120", delta: { tone: "good", up: true }, caption: "sites linking here by the link index's summary, vs Oct 28" });
    expect(backlinks).toMatchObject({ value: "1,000", delta: null, caption: "links in total, same as Oct 28" });
    expect(rank).toMatchObject({ label: "Domain strength", delta: { text: "+10", tone: "good" } });
    expect(spam).toMatchObject({ value: "12", delta: { text: "+2", tone: "bad" } });
  });

  it("shows small counts as an absolute change", () => {
    const [domains] = overviewFigures(reading("2026-11-04", { referringDomains: 3 }), reading("2026-10-28", { referringDomains: 5 }), true, REVIEW);
    expect(domains).toMatchObject({ delta: { text: "−2", tone: "bad" } });
  });

  it("has no change on a first reading, and says so only for a tracked domain", () => {
    const tracked = overviewFigures(reading("2026-11-04"), null, true, REVIEW);
    for (const f of tracked) expect(valueOf(f)?.delta).toBeNull();
    expect(tracked[0].caption).toBe("sites linking here by the link index's summary, nothing earlier to compare");
    expect(overviewFigures(reading("2026-11-04"), null, false, REVIEW)[0].caption).toBe("sites linking here by the link index's summary");
  });

  it("mutes a rise in referring domains made mostly of high-spam domains, and says so", () => {
    const [domains] = overviewFigures(reading("2026-11-04", { referringDomains: 115 }), OCT, true, REVIEW, { fresh: 12, high: 9 });
    expect(domains).toMatchObject({ delta: { tone: "muted", up: true }, caption: "sites linking here by the link index's summary, vs Oct 28. 9 of 12 new score high for spam" });
    const [calm] = overviewFigures(reading("2026-11-04", { referringDomains: 115 }), OCT, true, REVIEW, { fresh: 12, high: 2 });
    expect(calm).toMatchObject({ delta: { tone: "good" } });
  });
});

describe("newDomainSpam", () => {
  it("counts the listed domains first seen after the earlier reading, and those scoring 60 or more", () => {
    const rows = [
      { firstSeen: "2026-10-30 10:00:00 +00:00", spamScore: 72 },
      { firstSeen: "2026-11-02 10:00:00 +00:00", spamScore: 60 },
      { firstSeen: "2026-11-03 10:00:00 +00:00", spamScore: 12 },
      { firstSeen: "2026-10-28 10:00:00 +00:00", spamScore: 90 },
      { firstSeen: null, spamScore: 90 },
    ];
    expect(newDomainSpam(rows, "2026-10-28")).toEqual({ fresh: 3, high: 2 });
  });

  it("says why when the link index has no score", () => {
    const figures = overviewFigures(reading("2026-11-04", { rank: null, spamScore: null }), OCT, true, REVIEW);
    expect(figures[2]).toMatchObject({ state: "empty", label: "Domain strength" });
    expect(figures[3]).toMatchObject({ state: "empty", label: "Spam score" });
  });

  it("gives the spam score a verdict and a way to the links behind it", () => {
    const spam = (score: number, before: LinkReading | null, tracked = true) => overviewFigures(reading("2026-11-04", { spamScore: score }), before, tracked, REVIEW)[3];
    expect(spam(43, OCT)).toMatchObject({ value: "43", href: REVIEW, caption: "Middling score, lower is better. Across the links pointing here, out of 100, vs Oct 28" });
    expect(spam(10, OCT).caption).toBe("Low score, lower is better. Across the links pointing here, out of 100, same as Oct 28");
    expect(spam(70, null).caption).toBe("High score, lower is better. Across the links pointing here, out of 100, nothing earlier to compare");
    expect(spam(70, null, false).caption).toBe("High score, lower is better. Across the links pointing here, out of 100");
  });

  it("gives no spam verdict with no backlinks for the score to judge", () => {
    const spam = overviewFigures(reading("2026-11-04", { backlinks: 0, referringDomains: 0, spamScore: 0 }), OCT, true, REVIEW)[3];
    expect(spam).toMatchObject({ value: "0", caption: "Across the links pointing here, out of 100, vs Oct 28" });
  });

  it("gives domain strength no verdict, only what it's useful for", () => {
    const rank = (before: LinkReading | null, tracked = true) => overviewFigures(reading("2026-11-04", { rank: 66 }), before, tracked, REVIEW)[2];
    expect(rank(OCT).caption).toBe("Score out of 1,000, vs Oct 28. Most useful compared with competitors");
    expect(rank(null, false).caption).toBe("Score out of 1,000. Most useful compared with competitors");
    expect(rank(OCT)).not.toHaveProperty("href");
  });
});

describe("spamVerdict", () => {
  it("steps at the review rules' scores", () => {
    expect(spamVerdict(0)).toBe("Low score");
    expect(spamVerdict(29)).toBe("Low score");
    expect(spamVerdict(30)).toBe("Middling score");
    expect(spamVerdict(59)).toBe("Middling score");
    expect(spamVerdict(60)).toBe("High score");
  });
});

describe("loadPromptText", () => {
  it("speaks for the whole page when nothing is on it", () => {
    expect(loadPromptText("The backlink overview", "example.com", "7 days")).toEqual({
      title: "The backlink overview for example.com isn't loaded yet",
      description: `Loading it ${rules.hasPlans ? "uses research credits" : "spends on DataForSEO"}. It's then kept for 7 days, so reloading and sharing the page are free afterwards.`,
    });
  });

  it("agrees with a plural name", () => {
    expect(loadPromptText("Anchors", "betaweb.example", "7 days")).toEqual({
      title: "Anchors for betaweb.example aren't loaded yet",
      description: `Loading them ${rules.hasPlans ? "uses research credits" : "spends on DataForSEO"}. They're then kept for 7 days, so reloading and sharing the page are free afterwards.`,
    });
    expect(loadPromptText("Live referring domains", "betaweb.example", "7 days").title).toBe("Live referring domains for betaweb.example aren't loaded yet");
    expect(loadPromptText("The link gap against a.com, b.com", "betaweb.example", "7 days").title).toBe("The link gap against a.com, b.com for betaweb.example isn't loaded yet");
    expect(loadPromptText("The rest of the overview", "betaweb.example", "7 days").title).toBe("The rest of the overview for betaweb.example isn't loaded yet");
  });

  it("names what's missing when stored numbers are already showing", () => {
    expect(loadPromptText("The rest of the overview", "example.com", "7 days", "Domain endings and the link profile")).toEqual({
      title: "Domain endings and the link profile aren't loaded yet",
      description: `Loading them ${rules.hasPlans ? "uses research credits" : "spends on DataForSEO"}. They're then kept for 7 days, so reloading and sharing the page are free afterwards.`,
    });
  });
});

describe("freshnessOf", () => {
  const TZ = "America/New_York";

  it("says just now when anything was fetched fresh", () => {
    expect(freshnessOf([{ cached: true, fetchedAt: new Date("2026-11-02T12:00:00Z") }, { cached: false, fetchedAt: null }], TZ)).toBe("Fetched just now.");
  });

  it("gives the older date when both are saved", () => {
    expect(freshnessOf([{ cached: true, fetchedAt: new Date("2026-11-02T12:00:00Z") }, { cached: true, fetchedAt: new Date("2026-10-30T12:00:00Z") }], TZ)).toBe("Last fetched Oct 30.");
  });

  it("doesn't invent a date it doesn't have", () => {
    expect(freshnessOf([{ cached: true, fetchedAt: null }], TZ)).toBe("Loaded from saved data.");
  });
});

describe("overviewFreshness", () => {
  const TZ = "America/New_York";
  const NUMBERS = { cached: true, fetchedAt: new Date("2026-11-06T22:58:00Z") };
  const TREND = { cached: true, fetchedAt: new Date("2026-11-03T12:00:00Z") };

  it("gives the numbers and the trend their own dates when they differ", () => {
    expect(overviewFreshness(NUMBERS, TREND, TZ)).toBe("Numbers fetched Nov 6, monthly trend fetched Nov 3.");
    expect(overviewFreshness({ cached: false, fetchedAt: null }, TREND, TZ)).toBe("Numbers fetched just now, monthly trend fetched Nov 3.");
  });

  it("gives one date when they agree, and none it doesn't have", () => {
    expect(overviewFreshness(NUMBERS, { ...NUMBERS }, TZ)).toBe("Last fetched Nov 6.");
    expect(overviewFreshness({ cached: false, fetchedAt: null }, { cached: false, fetchedAt: null }, TZ)).toBe("Fetched just now.");
    expect(overviewFreshness({ cached: true, fetchedAt: null }, { cached: true, fetchedAt: null }, TZ)).toBe("Loaded from saved data.");
  });
});

describe("readingDay", () => {
  const NOW = new Date("2026-11-07T06:00:00Z");

  it("dates saved numbers by the day they were fetched, so they aren't compared with their own snapshot", () => {
    const day = readingDay({ fetchedAt: new Date("2026-11-06T22:58:00Z") }, NOW);
    expect(day).toBe("2026-11-06");
    expect(readingBefore([{ date: "2026-11-02" }, { date: "2026-11-06" }], day)).toEqual({ date: "2026-11-02" });
  });

  it("dates fresh numbers today", () => {
    expect(readingDay({ fetchedAt: null }, NOW)).toBe("2026-11-07");
  });
});

describe("monthSpan", () => {
  it("names the months the chart holds, however many that is", () => {
    expect(monthSpan([{ date: "2025-11" }, { date: "2026-05" }, { date: "2026-11" }])).toBe("Per month, Nov 2025 to Nov 2026");
    expect(monthSpan([{ date: "2026-11" }])).toBe("Per month, Nov 2026");
    expect(monthSpan([])).toBe("Per month");
  });
});

describe("domainSpamRow", () => {
  it("says this score is the domain's own, not the links'", () => {
    expect(domainSpamRow(2)).toEqual(["This domain's own spam score", "2"]);
    expect(domainSpamRow(null)).toEqual(["This domain's own spam score", "–"]);
  });
});

describe("referring domains", () => {
  const NOW = new Date("2026-11-04T00:00:00Z");
  const row = (over: Partial<DomainFacts> = {}): DomainFacts => ({ firstSeen: "2025-01-01", lostDate: null, nofollow: false, spamScore: 5, ...over });

  it("counts the domains that started or stopped linking", () => {
    expect(domainsSentence("live", 3, [row({ firstSeen: "2026-10-30" }), row({ firstSeen: "2026-10-20" }), row()], NOW)).toBe("Two domains started linking in the last 30 days.");
    expect(domainsSentence("lost", 2, [row({ lostDate: "2026-10-30" }), row({ lostDate: "2025-01-01" })], NOW)).toBe("One domain stopped linking in the last 30 days.");
  });

  it("is calm when nothing is recent", () => {
    expect(domainsSentence("live", 1, [row()], NOW)).toBe("No new domains in the last 30 days.");
    expect(domainsSentence("lost", 2, [row({ lostDate: "2025-01-01" }), row({ lostDate: "2025-02-01" })], NOW)).toBe("Two domains stopped linking, none of them in the last 30 days.");
  });

  it("speaks only for the domains loaded when the list is longer", () => {
    const old = [row(), row()];
    expect(domainsSentence("live", 3000, old, NOW)).toBe("None of the 2 strongest domains started linking in the last 30 days.");
    expect(domainsSentence("live", 3000, [row({ firstSeen: "2026-10-30" }), row()], NOW)).toBe("One of the 2 strongest domains started linking in the last 30 days.");
    expect(domainsSentence("lost", 3000, [row({ lostDate: "2025-01-01" }), row({ lostDate: "2025-02-01" })], NOW)).toBe("3,000 domains stopped linking, none of the 2 strongest in the last 30 days.");
    expect(domainsSentence("lost", 3000, [row({ lostDate: "2026-10-30" }), row({ lostDate: "2025-02-01" })], NOW)).toBe("One of the 2 strongest lost domains stopped linking in the last 30 days.");
  });

  it("gives the count alone when a total arrives with no rows", () => {
    expect(domainsSentence("live", 12, [], NOW)).toBe("12 domains link here.");
    expect(domainsSentence("lost", 12, [], NOW)).toBe("12 domains stopped linking.");
  });

  it("has nothing to say about an empty list but that", () => {
    expect(domainsSentence("live", 0, [], NOW)).toBe("No domains link here yet.");
    expect(domainsSentence("lost", 0, [], NOW)).toBe("No lost domains on record.");
  });

  it("gives four figures, with the spam count pointing at the review", () => {
    const [total, recent, followed, spam] = domainsFigures("live", 900, [row({ firstSeen: "2026-10-30" }), row({ nofollow: true, spamScore: 60 })], "/backlinks/toxic?q=a.com", NOW);
    expect(total).toMatchObject({ label: "Referring domains", value: "900", caption: "link here now by the link index's domain list, which counts apart from its summary on Overview" });
    expect(domainsFigures("lost", 900, [], "/backlinks/toxic?q=a.com", NOW)[0]).toMatchObject({ label: "Lost domains" });
    expect(recent).toMatchObject({ label: "New in 30 days", value: "1", caption: "in the 2 shown" });
    expect(followed).toMatchObject({ value: "1 of 2" });
    expect(spam).toMatchObject({ value: "1", href: "/backlinks/toxic?q=a.com" });
  });
});

describe("links", () => {
  const row = (over: Partial<LinkFacts> = {}): LinkFacts => ({ dofollow: true, is_new: false, is_broken: false, ...over });

  it("says what's new or broken, and how much of the list it read", () => {
    expect(linksSentence("live", 2, [row({ is_new: true }), row()])).toBe("Of two links, one is new.");
    expect(linksSentence("live", 900, [row({ is_new: true }), row({ is_new: true }), row({ is_broken: true })])).toBe("Of the 3 strongest links, two are new and one is broken.");
  });

  it("is calm when there's nothing to flag", () => {
    expect(linksSentence("live", 900, [row(), row()])).toBe("Nothing new or broken among the 2 strongest links.");
    expect(linksSentence("live", 0, [])).toBe("No links point here yet.");
  });

  it("counts new and lost lists", () => {
    expect(linksSentence("new", 1, [row()])).toBe("One new link on record.");
    expect(linksSentence("lost", 40, [row()])).toBe("40 lost links on record.");
    expect(linksSentence("lost", 0, [])).toBe("No lost links on record.");
  });

  it("gives four figures", () => {
    const figures = linksFigures("live", 12, [row({ dofollow: false, is_new: true }), row({ is_broken: true })]);
    expect(figures.map((f) => f.state === "value" && f.value)).toEqual(["12", "1 of 2", "1", "1"]);
  });
});

describe("anchors", () => {
  it("names the largest type, as a share", () => {
    expect(anchorsSentence([{ class: "branded", backlinks: 60 }, { class: "generic", backlinks: 40 }], 2)).toBe("60% of links mention your brand.");
  });

  it("counts a small total instead of a percentage", () => {
    expect(anchorsSentence([{ class: "generic", backlinks: 3 }, { class: "other", backlinks: 2 }], 2)).toBe("Three of five links use generic words such as “click here”.");
  });

  it("is calm with no links", () => {
    expect(anchorsSentence([], 0)).toBe("No link text on record yet.");
  });

  it("speaks only for the link texts loaded when there are more", () => {
    const rows = [{ class: "branded" as const, backlinks: 60 }, { class: "generic" as const, backlinks: 40 }];
    expect(anchorsSentence(rows, 3000)).toBe("Among the 2 most used link texts, 60% of links mention your brand.");
    const [, branded, keywords, generic] = anchorsFigures(rows, 3000, true, "/x");
    expect(branded).toMatchObject({ value: "60%", caption: "of links mention your brand, in the 2 shown" });
    expect(keywords).toMatchObject({ caption: "of links use your keywords, in the 2 shown" });
    expect(generic).toMatchObject({ caption: "of links say “click here” or the like, in the 2 shown" });
    expect(anchorsFigures(rows, 2, true, "/x")[1]).toMatchObject({ caption: "of links mention your brand" });
  });

  it("asks for keywords rather than showing a false zero", () => {
    const rows = [{ class: "exact" as const, backlinks: 1 }, { class: "branded" as const, backlinks: 3 }];
    expect(anchorsFigures(rows, 2, true, "/x")[2]).toMatchObject({ state: "value", value: "25%" });
    expect(anchorsFigures(rows, 2, false, "/x")[2]).toMatchObject({ state: "empty", action: { href: "/x" } });
  });
});

describe("link gap", () => {
  it("counts prospects, one and many", () => {
    expect(gapSentence([{ competitorCount: 1 }], ["rival.com"], "me.com")).toBe("One domain links to rival.com but not to me.com.");
    expect(gapSentence([{ competitorCount: 2 }, { competitorCount: 1 }, { competitorCount: 1 }], ["a.com", "b.com"], "me.com")).toBe("Three domains link to your competitors but not to me.com, and one of them links to more than one.");
  });

  it("is calm when there's no gap", () => {
    expect(gapSentence([], ["rival.com"], "me.com")).toBe("Nothing found: the strongest sites linking to rival.com already link to me.com too.");
  });

  it("gives four figures", () => {
    const figures = gapFigures([{ competitorCount: 2, spamScore: 5 }, { competitorCount: 1, spamScore: 70 }, { competitorCount: 1, spamScore: null }], ["a.com", "b.com"], 200);
    expect(figures.map((f) => f.state === "value" && f.value)).toEqual(["3", "1", "1", "2"]);
  });
});

describe("gapHiddenNote", () => {
  it("names the universal linkers, then your own and the competitors' other sites", () => {
    expect(gapHiddenNote({ universalLinkers: ["google.com", "facebook.com"], ownSites: ["rival.ru"] }, "fernhill.example")).toBe("Not shown: google.com and facebook.com, which link to nearly every site; rival.ru, a competitor's own site.");
    expect(gapHiddenNote({ universalLinkers: ["t.co"], ownSites: ["fernhill.de", "rival.ru", "other.fr"] }, "fernhill.example")).toBe("Not shown: t.co, which links to nearly every site; fernhill.de, your own site; rival.ru and other.fr, competitors' own sites.");
  });

  it("counts past five names", () => {
    const names = ["google.com", "bing.com", "x.com", "t.co", "reddit.com", "archive.org", "bit.ly"];
    expect(gapHiddenNote({ universalLinkers: names, ownSites: [] }, "fernhill.example")).toBe("Not shown: google.com, bing.com, x.com, t.co, reddit.com, and 2 more, which link to nearly every site.");
  });

  it("says nothing when nothing was left out", () => {
    expect(gapHiddenNote({ universalLinkers: [], ownSites: [] }, "fernhill.example")).toBeNull();
  });
});

describe("link review", () => {
  it("says what's flagged, one and many", () => {
    expect(reviewSentence({ risky: 2, review: 1, ok: 4 }, 0)).toBe("Two domains look risky and one needs review.");
    expect(reviewSentence({ risky: 1, review: 0, ok: 4 }, null)).toBe("One domain looks risky.");
    expect(reviewSentence({ risky: 0, review: 12, ok: 4 }, 3)).toBe("12 domains need review. Three are marked disavow.");
  });

  it("is calm with nothing flagged or nothing to review", () => {
    expect(reviewSentence({ risky: 0, review: 0, ok: 4 }, 0)).toBe("Nothing flagged across four linking domains.");
    expect(reviewSentence({ risky: 0, review: 0, ok: 0 }, null)).toBe("No linking domains to review.");
  });

  it("explains the disavow figure on a domain that isn't the project's", () => {
    expect(reviewFigures({ risky: 1, review: 2, ok: 3 }, 4)[3]).toMatchObject({ state: "value", value: "4", caption: "in disavow.txt" });
    expect(reviewFigures({ risky: 1, review: 2, ok: 3 }, null)[3]).toMatchObject({ state: "empty" });
  });
});

describe("filterHref", () => {
  it("keeps the other params and leaves out the default", () => {
    expect(filterHref("/backlinks/links", { q: "a.com", view: "domain" }, "status", "new", "live")).toBe("/backlinks/links?q=a.com&view=domain&status=new");
    expect(filterHref("/backlinks/links", { q: "a.com", status: "new" }, "status", "live", "live")).toBe("/backlinks/links?q=a.com");
  });

  it("never carries run, which spends on load", () => {
    expect(filterHref("/backlinks/links", { q: "a.com", run: "1" }, "status", "new", "live")).toBe("/backlinks/links?q=a.com&status=new");
  });
});

describe("columnsWithData", () => {
  const columns = [{ key: "a" }, { key: "b" }, { key: "c" }];

  it("hides a column empty in every row", () => {
    expect(columnsWithData(columns, [{ a: 1, b: null, c: "" }, { a: 0, b: undefined, c: "x" }]).map((c) => c.key)).toEqual(["a", "c"]);
  });

  it("keeps them all with no rows, so the table still has its heads", () => {
    expect(columnsWithData(columns, [])).toEqual(columns);
  });
});
