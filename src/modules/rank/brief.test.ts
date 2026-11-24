import { describe, expect, it } from "vitest";
import { formatDateTimeZoned } from "@/lib/format";
import {
  firstCheckSentence,
  cannibalFigures,
  cannibalSentence,
  competitorFigures,
  competitorRows,
  competitorSentence,
  keywordsNotConfirmedNote,
  dayRange,
  checkHistoryRow,
  googleResultsDescription,
  keywordCheckedLabel,
  keywordFigures,
  keywordSentence,
  keywordVolume,
  notConfirmedTitle,
  pointsNotConfirmed,
  runDay,
  runProgress,
  pagesFigures,
  pagesSentence,
  positionHistory,
  rankFigures,
  rankSentence,
  trendNote,
  withoutEmptyColumns,
  type KeywordReading,
} from "./brief";
import type { RankingRow } from "./components/rankings-table";
import type { Summary } from "./metrics";
import type { DatePoint } from "./overview";

const point = (date: string, over: Partial<DatePoint> = {}): DatePoint => ({ date, keywords: 10, visibility: 0.1, shareOfVoice: 0.05, traffic: 100, avgPosition: 12, top3: 1, top10: 3, top20: 5, top100: 8, ...over }) as DatePoint;

const row = (start: number | null, position: number | null, change: RankingRow["change"] = "unchanged") => ({ start, position, change }) as RankingRow;

const OCT = point("2026-10-28");
const NOV = point("2026-11-04");

describe("firstCheckSentence", () => {
  const time = "06:00 ET";
  it("offers Check now when it would work", () => {
    expect(firstCheckSentence({ running: false, refused: false, time })).toBe("Waiting for the first check. It runs every day at 06:00 ET, or Check now runs one sooner.");
  });
  it("says a check is running when one is", () => {
    expect(firstCheckSentence({ running: true, refused: false, time })).toBe("The first check is running. Results show here as they come in.");
  });
  it("doesn't offer a button that's off", () => {
    expect(firstCheckSentence({ running: false, refused: true, time })).toBe("Waiting for the first check.");
  });
  it("promises nothing on the Free plan, which runs no rank checks by hand or on schedule", () => {
    const free = firstCheckSentence({ running: false, refused: false, free: true, time });
    expect(free).toBe("Rank checks aren't part of the Free plan, so these keywords won't be checked. Choose a plan on the Billing page to run them.");
    expect(free).not.toContain("Check now");
    expect(free).not.toContain(time);
    // A check started before the plan changed is still running, so that's what's true.
    expect(firstCheckSentence({ running: true, refused: false, free: true, time })).toBe("The first check is running. Results show here as they come in.");
  });
});

describe("dayRange", () => {
  it("collapses a single day", () => {
    expect(dayRange("2026-11-03", "2026-11-03")).toBe("Nov 3, 2026");
  });
  it("gives both ends of a longer run", () => {
    expect(dayRange("2026-10-28", "2026-11-03")).toBe("Oct 28, 2026 to Nov 3, 2026");
  });
});

describe("rankSentence", () => {
  it("waits for the first check", () => {
    expect(rankSentence({ rows: [], start: null, end: null })).toBe("Waiting for the first check.");
  });

  it("says when there is only one check", () => {
    expect(rankSentence({ rows: [row(4, 4)], start: NOV, end: NOV })).toBe("First check on Nov 4. Changes show after the next one.");
  });

  it("leads on page one, both ways", () => {
    const rows = [row(14, 8, "improved"), row(15, 9, "improved"), row(7, 12, "declined")];
    expect(rankSentence({ rows, start: OCT, end: NOV })).toBe("Two keywords reached page one and one fell off, compared with Oct 28.");
  });

  it("doesn't call a keyword the earlier check didn't find a climb", () => {
    const found = (n: number) => Array.from({ length: n }, () => row(null, 9, "new"));
    expect(rankSentence({ rows: found(1), start: OCT, end: NOV })).toBe("One keyword the Oct 28 check didn't find is on page one.");
    expect(rankSentence({ rows: found(10), start: OCT, end: NOV })).toBe("10 keywords the Oct 28 check didn't find are on page one.");
    expect(rankSentence({ rows: [row(14, 8, "improved"), ...found(2)], start: OCT, end: NOV })).toBe("One keyword reached page one and two the Oct 28 check didn't find are there too.");
    expect(rankSentence({ rows: [row(7, 12, "declined"), ...found(2)], start: OCT, end: NOV })).toBe("Two keywords the Oct 28 check didn't find are on page one, and one fell off.");
  });

  it("leaves nothing out when keywords reached page one, were found on it and fell off it", () => {
    const rows = [row(11, 8, "improved"), row(16, 9, "improved"), row(11, 7, "improved"), row(12, 5, "improved"), ...Array.from({ length: 10 }, () => row(null, 9, "new")), row(10, 11, "declined"), row(8, 16, "declined")];
    expect(rankSentence({ rows, start: OCT, end: NOV })).toBe("Four keywords reached page one and 10 the Oct 28 check didn't find are there too, and two fell off.");
  });

  it("gets one and many right on a single side", () => {
    expect(rankSentence({ rows: [row(14, 8, "improved")], start: OCT, end: NOV })).toBe("One keyword reached page one, compared with Oct 28.");
  });

  it("doesn't call an unconfirmed position a move, and still adds up to the figure", () => {
    const carried = (start: number | null, position: number | null) => ({ ...row(start, position), notChecked: true }) as RankingRow;
    expect(rankSentence({ rows: [row(14, 8, "improved"), row(7, 12, "declined"), carried(14, 9), carried(null, 6)], start: OCT, end: NOV })).toBe("One keyword reached page one and one fell off, compared with Oct 28. Two more are on page one but weren't confirmed.");
    expect(rankSentence({ rows: [row(14, 8, "improved"), carried(14, 9)], start: OCT, end: NOV })).toBe("One keyword reached page one, compared with Oct 28. One more is on page one but wasn't confirmed.");
    expect(rankSentence({ rows: [carried(14, 9), carried(14, 8)], start: OCT, end: NOV })).toBe("No confirmed moves since Oct 28. Two keywords are on page one but weren't confirmed.");
    // Already on page one at the start, so it isn't a gain to explain.
    expect(rankSentence({ rows: [row(4, 4), carried(5, 5)], start: OCT, end: NOV })).toBe("Nothing moved since Oct 28.");
    expect(rankSentence({ rows: [row(4, null, "lost"), row(9, 11, "declined")], start: OCT, end: NOV })).toBe("Two keywords fell off page one, compared with Oct 28.");
  });

  it("falls back to any move, then to nothing", () => {
    const rows = [row(30, 20, "improved"), row(5, 3, "improved"), row(40, 20, "improved"), row(12, 15, "declined")];
    expect(rankSentence({ rows, start: OCT, end: NOV })).toBe("Three keywords moved up and one moved down, compared with Oct 28.");
    expect(rankSentence({ rows: [row(30, 40, "declined")], start: OCT, end: NOV })).toBe("One keyword moved down, compared with Oct 28.");
    expect(rankSentence({ rows: [row(4, 4)], start: OCT, end: NOV })).toBe("Nothing moved since Oct 28.");
  });
});

describe("what a check's results say", () => {
  const run = { tasksDone: 31, tasksTotal: 31, tasksFailed: 0, rechecks: 36, notChecked: 9 };

  it("counts extra looks as looks and repeated positions as not confirmed", () => {
    expect(runProgress(run)).toBe("31 of 31, 36 extra looks, 9 not confirmed");
    expect(runProgress({ ...run, rechecks: 1, notChecked: 0 })).toBe("31 of 31, 1 extra look");
    expect(runProgress({ ...run, tasksDone: 29, tasksFailed: 2, rechecks: 0, notChecked: 0 })).toBe("29 of 31 (2 failed)");
  });

  it("doesn't call a keyword it looked for not checked", () => {
    expect(notConfirmedTitle(9)).toBe("9 keywords not confirmed in the last check");
    expect(notConfirmedTitle(1)).toBe("1 keyword not confirmed in the last check");
  });
});

describe("rankFigures", () => {
  it("compares with the first check and reads position as better or worse", () => {
    const [visibility, position, pageOne, traffic] = rankFigures({ start: OCT, end: point("2026-11-04", { visibility: 0.12, avgPosition: 10, top10: 5, traffic: 150 }) });
    expect(visibility).toMatchObject({ value: "12.0%", delta: { tone: "good", text: "+2 pts" } });
    expect(position).toMatchObject({ label: "Tracked position", value: "10.0", delta: { text: "2 better", tone: "good", up: true }, position: { value: 10, previous: 12 } });
    expect(pageOne).toMatchObject({ value: "5 of 10", delta: { text: "+2" } });
    expect(traffic).toMatchObject({ value: "150", delta: { tone: "good" }, caption: "vs Oct 28" });
    expect(visibility).toMatchObject({ caption: "100% is #1 for every keyword, vs Oct 28" });
    expect(position).toMatchObject({ caption: "8 ranking, vs Oct 28" });
    expect(pageOne).toMatchObject({ caption: "in the top 10, vs Oct 28" });
    const unconfirmed = rankFigures({ start: point("2026-10-28"), end: point("2026-11-04", { top10NotConfirmed: 2 }) }).find((f) => f.id === "page-one");
    expect(unconfirmed).toMatchObject({ caption: "in the top 10, 2 of the 3 not confirmed, vs Oct 28" });
  });

  it("says how much of Visibility and Est. traffic no look confirmed", () => {
    const end = point("2026-11-04", { visibilityNotConfirmed: 0.0724, trafficNotConfirmed: 109.4 });
    const [visibility, , , traffic] = rankFigures({ start: OCT, end });
    expect(visibility).toMatchObject({ caption: "100% is #1 for every keyword, 7.2 pts not confirmed, vs Oct 28" });
    expect(traffic).toMatchObject({ caption: "109 not confirmed, vs Oct 28" });
    const [one, , , oneTraffic] = rankFigures({ start: end, end });
    expect(one).toMatchObject({ caption: "100% is #1 for every keyword, 7.2 pts not confirmed" });
    expect(oneTraffic).toMatchObject({ caption: "109 not confirmed, what these positions would bring" });
  });

  it("says nothing when the unconfirmed share rounds away", () => {
    const [visibility, , , traffic] = rankFigures({ start: OCT, end: point("2026-11-04", { visibilityNotConfirmed: 0.0004, trafficNotConfirmed: 0.4 }) });
    expect(visibility).toMatchObject({ caption: "100% is #1 for every keyword, vs Oct 28" });
    expect(traffic).toMatchObject({ caption: "vs Oct 28" });
  });

  it("says when positions no look confirmed change Tracked position", () => {
    const end = point("2026-11-04", { avgPosition: 10, avgPositionConfirmed: 11.5, rankingNotConfirmed: 2 });
    const position = (start: DatePoint, e: DatePoint) => rankFigures({ start, end: e }).find((f) => f.id === "position");
    expect(position(OCT, end)).toMatchObject({ value: "10.0", caption: "8 ranking, 2 not confirmed, 11.5 without them, vs Oct 28" });
    expect(position(end, end)).toMatchObject({ caption: "8 ranking, 2 not confirmed, 11.5 without them" });
  });

  it("says nothing of them when the average reads the same without them", () => {
    const end = point("2026-11-04", { avgPosition: 10.01, avgPositionConfirmed: 10.04, rankingNotConfirmed: 2 });
    expect(rankFigures({ start: OCT, end }).find((f) => f.id === "position")).toMatchObject({ caption: "8 ranking, vs Oct 28" });
  });

  it("counts them when every ranking keyword is one, with no average left to give", () => {
    const end = point("2026-11-04", { avgPosition: 4, avgPositionConfirmed: null, top100: 3, rankingNotConfirmed: 3 });
    expect(rankFigures({ start: OCT, end }).find((f) => f.id === "position")).toMatchObject({ caption: "3 ranking, 3 not confirmed, vs Oct 28" });
  });

  it("reads one point as a point", () => {
    const [visibility] = rankFigures({ start: OCT, end: point("2026-11-04", { visibilityNotConfirmed: 0.01 }) });
    expect(visibility).toMatchObject({ caption: "100% is #1 for every keyword, 1 pt not confirmed, vs Oct 28" });
  });

  it("has no change with a single check", () => {
    for (const f of rankFigures({ start: NOV, end: NOV })) expect(f).toMatchObject({ state: "value", delta: null });
  });

  it("leaves it to the sentence to say a single check has nothing earlier", () => {
    const figures = rankFigures({ start: NOV, end: NOV });
    expect(figures.map((f) => f.state === "value" && f.caption)).toEqual(["100% is #1 for every keyword", "8 ranking", "in the top 10", "what these positions would bring"]);
  });

  it("says nothing false before the first check", () => {
    expect(rankFigures({ start: null, end: null }).map((f) => f.state === "value" && f.value)).toEqual(["–", "–", "–", "–"]);
  });
});

const WEEK = { start: "2026-10-28", end: "2026-11-04" };
const ONE_DAY = { start: "2026-11-04", end: "2026-11-04" };

describe("pointsNotConfirmed", () => {
  it("reads at the figure's own precision", () => {
    expect(pointsNotConfirmed(0.0724)).toBe("7.2 pts not confirmed");
    expect(pointsNotConfirmed(0.01234, 2)).toBe("1.23 pts not confirmed");
    expect(pointsNotConfirmed(0.01, 2)).toBe("1 pt not confirmed");
  });

  it("is nothing when it rounds away or there's none", () => {
    expect(pointsNotConfirmed(0.0004)).toBe("");
    expect(pointsNotConfirmed(0.00004, 2)).toBe("");
    // Share of voice shows two decimals, so this much still moves it.
    expect(pointsNotConfirmed(0.0004, 2)).toBe("0.04 pts not confirmed");
    expect(pointsNotConfirmed(0)).toBe("");
    expect(pointsNotConfirmed(undefined)).toBe("");
  });
});

describe("trendNote", () => {
  it("names the newest check when it counts positions no look confirmed", () => {
    expect(trendNote(point("2026-11-04", { rankingNotConfirmed: 3 }))).toBe("the Nov 4 check counts 3 positions not confirmed");
    expect(trendNote(point("2026-11-04", { rankingNotConfirmed: 1 }))).toBe("the Nov 4 check counts 1 position not confirmed");
  });

  it("says nothing otherwise", () => {
    expect(trendNote(point("2026-11-04", { rankingNotConfirmed: 0 }))).toBe("");
    expect(trendNote(NOV)).toBe("");
    expect(trendNote(null)).toBe("");
  });
});

describe("withoutEmptyColumns", () => {
  it("hides only the listed columns, and only when every row is empty", () => {
    const columns = [{ key: "a" }, { key: "b" }, { key: "c" }];
    expect(withoutEmptyColumns(columns, [{ a: 0, b: null, c: 1 }, { a: 0, b: "", c: 0 }], ["b", "c"]).map((c) => c.key)).toEqual(["a", "c"]);
  });
});

describe("competitors", () => {
  const summary = (shareOfVoice: number | null, over: Partial<Summary> = {}): Summary => ({ keywords: 10, visibility: 0.1, shareOfVoice, traffic: 50, avgPosition: 12, top3: 1, top10: 3, notConfirmed: 0, top3NotConfirmed: 0, top10NotConfirmed: 0, rankingNotConfirmed: 0, visibilityNotConfirmed: 0, shareOfVoiceNotConfirmed: 0, trafficNotConfirmed: 0, avgPositionConfirmed: 12, top20: 5, top100: 8, ...over });
  const view = (start: Record<string, Summary>, end: Record<string, Summary>) => ({ domains: Object.keys(end), start: new Map(Object.entries(start)), end: new Map(Object.entries(end)) });
  const YOU = "you.com";

  it("waits on the next check with one, and says who leads when it can", () => {
    const alone = view({ [YOU]: summary(0.1) }, { [YOU]: summary(0.1) });
    expect(competitorSentence(alone, YOU, ONE_DAY)).toBe("First check on Nov 4. Changes show after the next one.");
    const two = view({ [YOU]: summary(0.1), "a.com": summary(0.2) }, { [YOU]: summary(0.1), "a.com": summary(0.2) });
    expect(competitorSentence(two, YOU, ONE_DAY)).toBe("First check on Nov 4, and a.com leads on share of voice so far.");
  });

  it("leads on who changed places with you", () => {
    const passed = view({ [YOU]: summary(0.2), "a.com": summary(0.1) }, { [YOU]: summary(0.1), "a.com": summary(0.2) });
    expect(competitorSentence(passed, YOU, WEEK)).toBe("a.com passed you on share of voice, compared with Oct 28.");
    const passing = view({ [YOU]: summary(0.1), "a.com": summary(0.2) }, { [YOU]: summary(0.2), "a.com": summary(0.1) });
    expect(competitorSentence(passing, YOU, WEEK)).toBe("You passed a.com on share of voice, compared with Oct 28.");
    const both = view({ [YOU]: summary(0.2), "a.com": summary(0.3), "b.com": summary(0.1), "c.com": summary(0.1) }, { [YOU]: summary(0.2), "a.com": summary(0.1), "b.com": summary(0.3), "c.com": summary(0.25) });
    expect(competitorSentence(both, YOU, WEEK)).toBe("You passed a.com and two competitors passed you on share of voice, compared with Oct 28.");
    const many = view({ [YOU]: summary(0.2), "b.com": summary(0.1), "c.com": summary(0.1) }, { [YOU]: summary(0.2), "b.com": summary(0.3), "c.com": summary(0.25) });
    expect(competitorSentence(many, YOU, WEEK)).toBe("Two competitors passed you on share of voice, compared with Oct 28.");
  });

  it("otherwise says how your share moved, and calmly when nothing did", () => {
    const rose = view({ [YOU]: summary(0.3), "a.com": summary(0.1) }, { [YOU]: summary(0.32), "a.com": summary(0.1) });
    expect(competitorSentence(rose, YOU, WEEK)).toBe("Your share of voice rose 2.0 points since Oct 28, and you lead.");
    const fell = view({ [YOU]: summary(0.1), "a.com": summary(0.3) }, { [YOU]: summary(0.08), "a.com": summary(0.3) });
    expect(competitorSentence(fell, YOU, WEEK)).toBe("Your share of voice fell 2.0 points since Oct 28, and a.com leads.");
    const held = view({ [YOU]: summary(0.1), "a.com": summary(0.3) }, { [YOU]: summary(0.1), "a.com": summary(0.35) });
    expect(competitorSentence(held, YOU, WEEK)).toBe("Your share of voice held at 10.00% since Oct 28, and a.com leads.");
    const still = view({ [YOU]: summary(0.1), "a.com": summary(0.3) }, { [YOU]: summary(0.1), "a.com": summary(0.3) });
    expect(competitorSentence(still, YOU, WEEK)).toBe("Nothing moved since Oct 28, and a.com leads.");
    expect(competitorSentence(view({ [YOU]: summary(0.1) }, { [YOU]: summary(0.1) }), YOU, WEEK)).toBe("Nothing moved since Oct 28.");
  });

  it("names no leader when nobody has any share", () => {
    const none = view({ [YOU]: summary(0), "a.com": summary(0) }, { [YOU]: summary(0), "a.com": summary(0) });
    expect(competitorSentence(none, YOU, WEEK)).toBe("Nothing moved since Oct 28.");
  });

  it("has your figures, with position as better or worse and competitors ahead as a count", () => {
    const v = view({ [YOU]: summary(0.1, { avgPosition: 12 }), "a.com": summary(0.05) }, { [YOU]: summary(0.08, { avgPosition: 9 }), "a.com": summary(0.2) });
    const [sov, , position, ahead] = competitorFigures(v, YOU, WEEK, "/settings");
    expect(sov).toMatchObject({ value: "8.00%", delta: { text: "−2 pts", tone: "bad" } });
    expect(position).toMatchObject({ label: "Tracked position", value: "9.0", delta: { text: "3 better", tone: "good" } });
    expect(ahead).toMatchObject({ value: "1 of 1", delta: { tone: "bad" } });
  });

  it("won't let Visibility's gap to competitors read as measured when it rests on positions no look confirmed", () => {
    const end = { [YOU]: summary(0.08, { visibilityNotConfirmed: 0.0724 }), "a.com": summary(0.2) };
    const start = { [YOU]: summary(0.1), "a.com": summary(0.05) };
    const visibility = (s: Record<string, Summary>, w: typeof WEEK) => competitorFigures(view(s, end), YOU, w, "/settings").find((f) => f.id === "visibility");
    expect(visibility(start, WEEK)).toMatchObject({ caption: "100% is #1 for every keyword, 7.2 pts not confirmed, so the gap to competitors isn't measured, vs Oct 28" });
    expect(visibility(start, ONE_DAY)).toMatchObject({ caption: "100% is #1 for every keyword, 7.2 pts not confirmed, so the gap to competitors isn't measured" });
  });

  it("has no gap to speak of with no competitors, and no note when nothing is unconfirmed", () => {
    const alone = { [YOU]: summary(0.08, { visibilityNotConfirmed: 0.0724 }) };
    expect(competitorFigures(view(alone, alone), YOU, ONE_DAY, "/settings").find((f) => f.id === "visibility")).toMatchObject({ caption: "100% is #1 for every keyword, 7.2 pts not confirmed" });
    const rounds = { [YOU]: summary(0.08, { visibilityNotConfirmed: 0.0004 }), "a.com": summary(0.2) };
    expect(competitorFigures(view(rounds, rounds), YOU, ONE_DAY, "/settings").find((f) => f.id === "visibility")).toMatchObject({ caption: "100% is #1 for every keyword" });
  });

  it("says how much of Share of voice and Tracked position rests on positions not confirmed, when that moves them", () => {
    const end = { [YOU]: summary(0.08, { shareOfVoiceNotConfirmed: 0.0123, avgPosition: 9, avgPositionConfirmed: 11, rankingNotConfirmed: 2 }), "a.com": summary(0.05) };
    const [sov, , position] = competitorFigures(view({ [YOU]: summary(0.1), "a.com": summary(0.05) }, end), YOU, WEEK, "/settings");
    expect(sov).toMatchObject({ caption: "your share of clicks on these searches, 1.23 pts not confirmed, vs Oct 28" });
    expect(position).toMatchObject({ caption: "8 ranking, 2 not confirmed, 11.0 without them, vs Oct 28" });
    const steady = { [YOU]: summary(0.08, { shareOfVoiceNotConfirmed: 0.00004, avgPosition: 9, avgPositionConfirmed: 9.04, rankingNotConfirmed: 2 }) };
    const [quietSov, , quietPosition] = competitorFigures(view(steady, steady), YOU, ONE_DAY, "/settings");
    expect(quietSov).toMatchObject({ caption: "your share of clicks on these searches" });
    expect(quietPosition).toMatchObject({ caption: "8 ranking" });
  });

  it("counts competitors ahead on confirmed positions too, when that count differs", () => {
    // a.com leads, but most of its share is on keywords whose results no look confirmed.
    const end = { [YOU]: summary(0.08), "a.com": summary(0.2, { shareOfVoiceNotConfirmed: 0.15 }), "b.com": summary(0.1) };
    const start = { [YOU]: summary(0.1), "a.com": summary(0.05), "b.com": summary(0.12) };
    const ahead = competitorFigures(view(start, end), YOU, WEEK, "/settings")[3];
    expect(ahead).toMatchObject({ value: "2 of 2", caption: "on share of voice, 1 on confirmed positions alone, vs Oct 28" });
    const same = { [YOU]: summary(0.08), "a.com": summary(0.2, { shareOfVoiceNotConfirmed: 0.01 }) };
    expect(competitorFigures(view(same, same), YOU, ONE_DAY, "/settings")[3]).toMatchObject({ caption: "on share of voice" });
  });

  it("says what the sentence would be on confirmed positions, when they'd change it", () => {
    const start = { [YOU]: summary(0.1), "a.com": summary(0.05) };
    const end = { [YOU]: summary(0.08), "a.com": summary(0.2, { shareOfVoiceNotConfirmed: 0.15 }) };
    expect(competitorSentence(view(start, end), YOU, WEEK)).toBe(
      "a.com passed you on share of voice, compared with Oct 28. That counts positions not confirmed; on confirmed positions alone, your share of voice fell 2.0 points since Oct 28, and you lead.",
    );
    expect(competitorSentence(view(end, end), YOU, ONE_DAY)).toBe("First check on Nov 4, and a.com leads on share of voice so far. That counts positions not confirmed; on confirmed positions alone, you lead.");
    const small = { [YOU]: summary(0.08), "a.com": summary(0.2, { shareOfVoiceNotConfirmed: 0.01 }) };
    expect(competitorSentence(view(small, small), YOU, ONE_DAY)).toBe("First check on Nov 4, and a.com leads on share of voice so far.");
  });

  it("captions Over time when its newest check repeats results no look confirmed", () => {
    expect(keywordsNotConfirmedNote(3, "2026-11-04")).toBe("the Nov 4 check counts 3 keywords not confirmed, for every domain");
    expect(keywordsNotConfirmedNote(1, "2026-11-04")).toBe("the Nov 4 check counts 1 keyword not confirmed, for every domain");
    expect(keywordsNotConfirmedNote(0, "2026-11-04")).toBe("");
  });

  it("offers to add competitors when there are none, and has no change on one check", () => {
    const v = view({ [YOU]: summary(0.1, { avgPosition: null }) }, { [YOU]: summary(0.1, { avgPosition: null }) });
    const figures = competitorFigures(v, YOU, ONE_DAY, "/settings");
    expect(figures[0]).toMatchObject({ delta: null, caption: "your share of clicks on these searches" });
    expect(figures[2]).toMatchObject({ state: "empty" });
    expect(figures[3]).toMatchObject({ state: "empty", action: { href: "/settings" } });
  });

  it("builds rows, most share first, with no change on a single check", () => {
    const v = view({ [YOU]: summary(0.1), "a.com": summary(0.3) }, { [YOU]: summary(0.1, { top100: 4, keywords: 12 }), "a.com": summary(0.2) });
    const rows = competitorRows(v, YOU, WEEK);
    expect(rows.map((r) => r.label)).toEqual(["a.com", "you.com (you)"]);
    expect(rows[0].shareChange).toBeCloseTo(-0.1);
    expect(rows[0].shareDelta).toMatchObject({ tone: "bad" });
    expect(rows[1]).toMatchObject({ isYou: true, ranking: "4 of 12" });
    for (const r of competitorRows(v, YOU, ONE_DAY)) expect(r).toMatchObject({ shareChange: null, shareDelta: null, visibilityChange: null });
  });
});

describe("pages", () => {
  const page = (url: string, keywords: number, keywordsDelta: number | null, traffic = 10) => ({ url, keywords, keywordsDelta, traffic });

  it("counts what's there until a second check", () => {
    expect(pagesSentence([page("https://a.com/x", 2, null)], [], ONE_DAY)).toBe("One page ranks for your tracked keywords on Nov 4. Changes show after the next check.");
    expect(pagesSentence([page("https://a.com/x", 2, null), page("https://a.com/y", 1, null)], [], WEEK)).toBe("Two pages rank for your tracked keywords on Nov 4. Changes show after the next check.");
  });

  it("says which pages gained or lost keywords, counting a page that fell out", () => {
    const moved = [page("https://a.com/x", 3, 1), page("https://a.com/y", 1, -1), page("https://a.com/z", 2, 2)];
    expect(pagesSentence(moved, [{ url: "https://a.com/gone", keywords: 2 }], WEEK)).toBe("Two pages gained keywords and two lost some, compared with Oct 28.");
    expect(pagesSentence([page("https://a.com/x", 3, 1)], [], WEEK)).toBe("One page gained keywords, compared with Oct 28.");
    expect(pagesSentence([page("https://a.com/x", 3, 0)], [{ url: "https://a.com/gone", keywords: 1 }], WEEK)).toBe("One page lost keywords, compared with Oct 28.");
    expect(pagesSentence([page("https://a.com/x", 3, 0)], [], WEEK)).toBe("Every page ranks for the same number of keywords as on Oct 28.");
  });

  it("compares page and keyword counts, new pages and dropped ones included", () => {
    const pages = [page("https://a.com/x", 3, 1, 30), page("https://a.com/new", 2, 2, 10)];
    const [count, keywords, traffic, top] = pagesFigures(pages, [{ url: "https://a.com/gone", keywords: 4 }], WEEK);
    expect(count).toMatchObject({ value: "2", delta: { text: "No change" } }); // One new, one gone.
    expect(keywords).toMatchObject({ value: "5", delta: { text: "−1", tone: "bad" } }); // 6 before: 2 + 4.
    expect(traffic).toMatchObject({ value: "40" });
    expect(top).toMatchObject({ value: "75%", caption: "of that traffic: /x" });
  });

  it("has no change on one check, no top page without traffic, and short paths", () => {
    const figures = pagesFigures([page("https://a.com/x", 3, null, 0)], [], ONE_DAY);
    expect(figures).toHaveLength(3);
    expect(figures.map((f) => f.state === "value" && f.caption)).toEqual(["in your tracked results", "across these pages", "what these positions would bring"]);
    expect(figures[0]).toMatchObject({ delta: null });
    const long = pagesFigures([page(`https://a.com/${"a".repeat(40)}`, 1, null, 5)], [], ONE_DAY);
    expect(long[3]).toMatchObject({ caption: `of that traffic: /${"a".repeat(26)}…` });
  });
});

describe("competing pages", () => {
  it("says where things stand across the window", () => {
    expect(cannibalSentence(3, 20, WEEK)).toBe("Three of 20 ranking keywords had two or more of your pages competing, Oct 28 to Nov 4.");
    expect(cannibalSentence(1, 1, ONE_DAY)).toBe("One of one ranking keyword had two or more of your pages competing, on Nov 4.");
    expect(cannibalSentence(0, 2, WEEK)).toBe("None of your two ranking keywords had two of your pages competing, Oct 28 to Nov 4.");
    expect(cannibalSentence(0, 0, WEEK)).toBe("None of your tracked keywords ranked from Oct 28 to Nov 4, so none of your pages are competing.");
    expect(cannibalSentence(0, 0, ONE_DAY)).toBe("None of your tracked keywords ranked on Nov 4, so none of your pages are competing.");
  });

  it("has the four numbers", () => {
    const [affected, clear, pages, volume] = cannibalFigures([{ volume: 100 }, { volume: null }], 8, 3, 6);
    expect(affected).toMatchObject({ value: "2 of 8" });
    expect(clear).toMatchObject({ value: "75%" });
    expect(pages).toMatchObject({ value: "3 of 6" });
    expect(volume).toMatchObject({ value: "100" });
    expect(cannibalFigures([], 0, 0, 0)[1]).toMatchObject({ value: "–" });
  });
});

describe("one keyword", () => {
  const check = (date: string, position: number | null, over: Partial<KeywordReading> = {}): KeywordReading => ({ date, position, depth: 20, notChecked: false, deeperCheckDate: null, checkedAt: new Date(`${date}T06:00:00Z`), ...over });
  const OLD = "2026-10-28";
  const NOW = "2026-11-04";

  it("handles no checks and one check", () => {
    expect(keywordSentence([])).toBe("No checks in this range. Results appear after the next one.");
    expect(keywordSentence([check(NOW, 8)])).toBe("One check in this range: position 8 on Nov 4.");
    expect(keywordSentence([check(NOW, null)])).toBe("One check in this range: not in the top 20 on Nov 4.");
  });

  it("says a miss may be false when Search Console has the keyword within the depth", () => {
    const missed = "Not found in the top 20 on Nov 4, but Search Console has it around 3.6 across every location, so this check may have missed it.";
    expect(keywordSentence([check(NOW, null)], 3.64)).toBe(missed);
    expect(keywordSentence([check(OLD, null), check(NOW, null)], 3.64)).toBe(missed);
    expect(keywordSentence([check(OLD, null), check(NOW, null)], 35)).toBe("Still not in the top 20, as on Oct 28.");
    expect(keywordSentence([check(NOW, 8)], 3.64)).toBe("One check in this range: position 8 on Nov 4.");
  });

  it("leads on page one, both ways", () => {
    expect(keywordSentence([check(OLD, 14), check(NOW, 8)])).toBe("Reached page one at position 8, up from 14 on Oct 28.");
    expect(keywordSentence([check(OLD, 8), check(NOW, 14)])).toBe("Fell off page one to position 14, down from 8 on Oct 28.");
    expect(keywordSentence([check(OLD, null), check(NOW, 8)])).toBe("On page one at position 8, after not being found on Oct 28.");
    expect(keywordSentence([check(OLD, 8), check(NOW, null)])).toBe("Fell off page one and out of the top 20, from position 8 on Oct 28.");
  });

  it("then any move, then a calm answer", () => {
    expect(keywordSentence([check(OLD, 30), check(NOW, 20)])).toBe("Up from 30 to 20 since Oct 28.");
    expect(keywordSentence([check(OLD, 3), check(NOW, 7)])).toBe("Down from 3 to 7 since Oct 28.");
    expect(keywordSentence([check(OLD, null), check(NOW, 15)])).toBe("Now at position 15, after not being found on Oct 28.");
    expect(keywordSentence([check(OLD, 15), check(NOW, null)])).toBe("Dropped out of the top 20, from position 15 on Oct 28.");
    expect(keywordSentence([check(OLD, 5), check(NOW, 5)])).toBe("Held position 5 since Oct 28.");
    expect(keywordSentence([check(OLD, null), check(NOW, null)])).toBe("Still not in the top 20, as on Oct 28.");
  });

  it("reads position as better or worse and says where it came from", () => {
    const [position, best, ai] = keywordFigures([check(OLD, 14), check(NOW, 8)], 6, { date: "2026-11-02", aiOverview: true, aiOverviewCited: true }, 90);
    expect(position).toMatchObject({ value: "8", delta: { text: "6 better", tone: "good", up: true }, position: { value: 8, previous: 14 }, caption: "on Nov 4, top 20 checked, vs Oct 28" });
    expect(best).toMatchObject({ value: "6", caption: "in the last 90 days" });
    expect(ai).toMatchObject({ value: "Cited", caption: "weekly check of Nov 2" });
    expect(keywordFigures([check(OLD, 8), check(NOW, 14)], 8, null, 30)[0]).toMatchObject({ delta: { text: "6 worse", tone: "bad", up: false } });
  });

  it("says a position is carried or unconfirmed", () => {
    expect(keywordFigures([check(NOW, 50, { deeperCheckDate: "2026-11-02" })], 50, null, 30)[0]).toMatchObject({ caption: "from the deeper check on Nov 2", delta: null });
    expect(keywordFigures([check(NOW, 5, { notChecked: true, checkedAt: new Date("2026-11-01T06:00:00Z") })], 5, null, 30)[0]).toMatchObject({ caption: "last seen Nov 1, not confirmed on Nov 4" });
  });

  it("doesn't claim a position no look confirmed, or a move on it", () => {
    const held = check(NOW, 7, { notChecked: true, checkedAt: new Date("2026-11-01T06:00:00Z") });
    const said = "Last seen at position 7 on Nov 1. The Nov 4 check didn't find it on any look, so that position isn't confirmed.";
    expect(keywordSentence([check(OLD, 7), held])).toBe(said);
    expect(keywordSentence([check(OLD, null), held])).toBe(said);
    expect(keywordSentence([held])).toBe(said);
    expect(keywordFigures([check(OLD, 9), held], 7, null, 30)[0]).toMatchObject({ value: "7", delta: null, caption: "last seen Nov 1, not confirmed on Nov 4" });
  });

  it("marks a check that repeats earlier results, in the header, Google results and Check history", () => {
    const at = new Date("2026-11-01T11:03:00Z");
    const seen = formatDateTimeZoned(at, "America/New_York");
    const held = { date: NOW, notChecked: true, checkedAt: at, depth: 20, seResultsCount: 1200 };
    expect(keywordCheckedLabel(held, "America/New_York")).toBe(`last seen ${seen}, not confirmed on Nov 4, 2026`);
    expect(keywordCheckedLabel({ ...held, notChecked: false }, "America/New_York")).toBe(`checked ${seen}`);
    expect(googleResultsDescription(held, "America/New_York")).toBe(
      `Nov 4, 2026 isn't confirmed: no look that day found this keyword's result, so these are the results last seen ${seen}, looking at the top 20. First 20 items.`,
    );
    expect(googleResultsDescription({ ...held, notChecked: false }, "America/New_York")).toBe(`Nov 4, 2026, checked ${seen}, looking at the top 20. 1,200 results. First 20 items.`);
    const row = { ...held, position: 7, url: "https://ours.com/", serpFeatures: ["local_pack"], aiOverviewLoaded: false, aiOverview: false, aiOverviewCited: false, ownUrls: ["https://ours.com/"] };
    expect(checkHistoryRow(row)).toMatchObject({ position: 7, seen: "not confirmed" });
    expect(checkHistoryRow({ ...row, notChecked: false })).toMatchObject({ seen: "" });
  });

  it("says which place its search volume is for", () => {
    expect(keywordVolume(390, "Salem, New Hampshire")).toBe("390 searches a month in Salem, New Hampshire");
    expect(keywordVolume(null, "United States")).toBe("no search volume on record in United States");
  });

  it("has words in place of numbers it doesn't have", () => {
    const [position, best, ai] = keywordFigures([], null, null, 7);
    expect(position).toMatchObject({ state: "empty", text: "Not checked in this range" });
    expect(best).toMatchObject({ state: "empty", text: "Not found in the last 7 days" });
    expect(ai).toMatchObject({ state: "empty", text: "No weekly check in this range" });
    expect(keywordFigures([check(NOW, null)], null, { date: NOW, aiOverview: true, aiOverviewCited: false }, 7)[0]).toMatchObject({ state: "empty", text: "Not in the top 20 on Nov 4" });
    expect(keywordFigures([check(NOW, null)], null, { date: NOW, aiOverview: true, aiOverviewCited: false }, 7)[2]).toMatchObject({ value: "Not cited" });
    expect(keywordFigures([check(NOW, null)], null, { date: NOW, aiOverview: false, aiOverviewCited: false }, 7)[2]).toMatchObject({ value: "None" });
  });
});

describe("positionHistory", () => {
  const line = (...values: (number | null)[]) => values.map((value, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, value }));
  const RIVALS = "You and your competitors in the same Google results. #1 is at the top.";
  const YOUR_LINE = "Where you ranked at each check. #1 is at the top.";
  const YOUR_WORDS = "Where you ranked at each check.";

  it("names competitors only when their lines draw", () => {
    expect(positionHistory(line(8, 7, 6, 5), [line(3, 4, 5, 6)])).toEqual({ withRivals: true, description: RIVALS });
    // Your line is flat, but a competitor moved, and that's worth the chart.
    expect(positionHistory(line(8, 8, 8, 8), [line(3, 4, 5, 6)])).toEqual({ withRivals: true, description: RIVALS });
  });

  it("drops competitors when nothing has moved enough to draw", () => {
    expect(positionHistory(line(8, 8, 8, 8), [line(3, 3, 3, 3)])).toEqual({ withRivals: false, description: YOUR_WORDS });
  });

  it("reads as words at two or three checks, with no chart to have a top", () => {
    expect(positionHistory(line(14, 8), [line(3, 5)])).toEqual({ withRivals: false, description: YOUR_WORDS });
    expect(positionHistory(line(14, 10, 8), [line(3, 4, 5)])).toEqual({ withRivals: false, description: YOUR_WORDS });
    expect(positionHistory(line(8), [])).toEqual({ withRivals: false, description: YOUR_WORDS });
    expect(positionHistory([], [])).toEqual({ withRivals: false, description: YOUR_WORDS });
  });

  it("mentions the top when your own line draws", () => {
    expect(positionHistory(line(8, 7, 6, 5), [])).toEqual({ withRivals: false, description: YOUR_LINE });
    // A check that found nothing is drawn as a miss, however few checks there are.
    expect(positionHistory(line(14, null), [line(3, 5)])).toEqual({ withRivals: false, description: YOUR_LINE });
  });
});

describe("runDay", () => {
  // Filed under 2026-11-03 in UTC, where it was already Tuesday.
  const LATE = new Date("2026-11-03T04:48:00Z");
  it("reads a check by the day it started in the workspace's zone", () => {
    expect(runDay(LATE, "America/New_York")).toBe("2026-11-02");
    expect(runDay(LATE, "Asia/Tokyo")).toBe("2026-11-03");
    expect(runDay(new Date("2026-11-02T20:00:00Z"), "Asia/Tokyo")).toBe("2026-11-03");
  });
});

describe("rankSentence after a newer check failed", () => {
  const row = (start: number | null, position: number | null, change: string) => ({ start, position, change }) as never;
  const o = { rows: [row(14, 8, "improved")], start: { date: "2026-11-01" }, end: { date: "2026-11-05" } } as never;

  it("dates what it says, so it can't read as today's news", () => {
    expect(rankSentence(o)).toBe("One keyword reached page one, compared with Nov 1.");
    expect(rankSentence(o, { newerFailed: true })).toBe("As of Nov 5, one keyword reached page one, compared with Nov 1.");
  });

  it("doesn't promise changes after the next check when the next check failed", () => {
    const first = { rows: [], start: { date: "2026-11-05" }, end: { date: "2026-11-05" } } as never;
    expect(rankSentence(first)).toBe("First check on Nov 5. Changes show after the next one.");
    expect(rankSentence(first, { newerFailed: true })).toBe("Only the Nov 5 check has results so far.");
  });
});
