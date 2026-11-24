import { describe, expect, it } from "vitest";
import { aioCoverage, aioSource, aiFigures, aiSentence, platformCount, brandsFigures, brandsSentence, promptFigures, promptSentence, promptsFigures, promptsSentence, sourcesFigures, sourcesSentence, promptsDescription, trendChart, waitingOnFirstRun, type PromptAnswer } from "./brief";
import { magnitude } from "@/components/ui/module-card";
import type { Overview } from "./data";

const totals = (over: Partial<Overview["current"]> = {}): Overview["current"] => ({ total: 12, mentioned: 3, cited: 1, score: 3 / 12, citedRate: 1 / 12, avgPosition: 2, ...over });
const trend = [{ date: "2026-10-28 07:00", visibility: 20 }, { date: "2026-11-04 07:00", visibility: 25 }];
const big = (mentioned: number, cited: number) => totals({ total: 40, mentioned, cited, score: mentioned / 40, citedRate: cited / 40 });

describe("aioCoverage", () => {
  it("says how many keywords the AI Overview numbers cover", () => {
    expect(aioCoverage(1, 9)).toBe("1 of 9 keywords checked so far. The others are checked with the next weekly run.");
  });

  it("says nothing when every keyword has been checked", () => {
    expect(aioCoverage(9, 9)).toBeNull();
    expect(aioCoverage(1, 1)).toBeNull();
  });
});

describe("promptsDescription", () => {
  it("says how often the prompts are asked, and what that costs where costs show", () => {
    expect(promptsDescription(3, { free: false, monthlyUsd: null })).toBe("3 active prompts · checked weekly");
    expect(promptsDescription(1, { free: false, monthlyUsd: 1.234 })).toBe("1 active prompt · ≈ $1.23/month at the weekly schedule, the mentions check included");
  });

  it("promises no weekly check on Free, which asks no AI questions", () => {
    expect(promptsDescription(3, { free: true, monthlyUsd: null })).toBe("3 active prompts · not checked on the Free plan");
  });
});

describe("waitingOnFirstRun", () => {
  it("says the prompts wait for their first run, or that Free doesn't ask them", () => {
    expect(waitingOnFirstRun(3, false)).toBe("3 prompts tracked, waiting for the first run");
    expect(waitingOnFirstRun(1, false)).toBe("1 prompt tracked, waiting for the first run");
    expect(waitingOnFirstRun(3, true)).toBe("3 prompts tracked, not checked on the Free plan");
  });
});

describe("aioSource", () => {
  it("says where and how often AI visibility looks, and that Rankings' daily look can differ", () => {
    expect(aioSource({ locationCode: 2840, cityCode: 1000001, cityName: "Salem, New Hampshire" })).toBe(
      "Weekly check of each prompt's keyword form on Google (desktop, United States). Rankings looks at its keywords daily (Salem, New Hampshire), and AI Overviews come and go, so the two can differ.",
    );
    expect(aioSource({ locationCode: 2840, cityCode: null, cityName: null })).toBe(
      "Weekly check of each prompt's keyword form on Google (desktop, United States). Rankings looks at its keywords daily, and AI Overviews come and go, so the two can differ.",
    );
  });
});

describe("aiSentence", () => {
  it("waits for the first run", () => {
    expect(aiSentence({ current: totals({ total: 0, mentioned: 0, cited: 0, score: null, citedRate: null }), previous: null, trend: [] })).toBe("Waiting for the first run.");
  });

  it("says what the first run found and when changes start", () => {
    expect(aiSentence({ current: totals(), previous: null, trend: trend.slice(1) })).toBe("First run on Nov 4: 3 of 12 answers name you. Changes show after the next one.");
    expect(aiSentence({ current: totals({ mentioned: 1 }), previous: null, trend: trend.slice(1) })).toBe("First run on Nov 4: 1 of 12 answers names you. Changes show after the next one.");
  });

  it("says how many of the first run's answers failed", () => {
    expect(aiSentence({ current: totals({ total: 2, mentioned: 1 }), previous: null, trend: trend.slice(1), failed: 1 })).toBe("First run on Nov 4: 1 of 2 answers names you, and 1 failed. Changes show after the next one.");
  });

  it("reports no change when the newest run got nothing back, and says whose answers these are", () => {
    expect(aiSentence({ current: totals({ total: 34, mentioned: 15 }), previous: null, trend, failed: 6, failedRun: "2026-11-09 07:00" })).toBe(
      "No answers came back from the Nov 9 run, so there's no change to report. These are the Nov 4 answers: 15 of 34 answers name you, and 6 failed.",
    );
  });

  it("counts answers on a small run, up and down", () => {
    expect(aiSentence({ current: totals({ mentioned: 5, cited: 1 }), previous: totals({ mentioned: 3, cited: 1 }), trend })).toBe("Two more answers name you, compared with Oct 28.");
    expect(aiSentence({ current: totals({ mentioned: 2, cited: 1 }), previous: totals({ mentioned: 3, cited: 1 }), trend })).toBe("One fewer answer names you, compared with Oct 28.");
  });

  it("leads on the bad news when one rate rises and the other falls", () => {
    expect(aiSentence({ current: totals({ mentioned: 5, cited: 0 }), previous: totals({ mentioned: 3, cited: 1 }), trend })).toBe("One fewer answer cites you, but two more answers name you, compared with Oct 28.");
  });

  it("moves in points on a large run", () => {
    expect(aiSentence({ current: big(14, 4), previous: big(10, 4), trend })).toBe("Visibility is up 10 points, compared with Oct 28.");
    expect(aiSentence({ current: big(10, 2), previous: big(10, 4), trend })).toBe("The share of answers citing you is down 5 points, compared with Oct 28.");
  });

  it("says one point in the singular, and only once", () => {
    const run = (mentioned: number) => totals({ total: 100, mentioned, cited: 4, score: mentioned / 100, citedRate: 4 / 100 });
    expect(aiSentence({ current: run(11), previous: run(10), trend })).toBe("Visibility is up 1 point, compared with Oct 28.");
  });

  it("uses points when the two runs asked different numbers", () => {
    const current = totals({ total: 16, mentioned: 4, cited: 2, score: 0.25, citedRate: 0.125 });
    const previous = totals({ total: 10, mentioned: 2, cited: 1, score: 0.2, citedRate: 0.1 });
    expect(aiSentence({ current, previous, trend })).toBe("Visibility is up 5 points, and the share of answers citing you is up 2.5 points, compared with Oct 28.");
  });

  it("words a move with the same rounding as the figure under it", () => {
    const current = totals({ total: 2, mentioned: 1, cited: 0, score: 1 / 2, citedRate: 0 });
    const previous = totals({ total: 80, mentioned: 17, cited: 0, score: 17 / 80, citedRate: 0 });
    const shown = magnitude(1 / 2 - 17 / 80, "points").replace(" pts", "");
    expect(aiSentence({ current, previous, trend })).toBe(`Visibility is up ${shown} points, compared with Oct 28.`);
  });

  it("says nothing moved when a change rounds to zero", () => {
    const previous = totals({ total: 2000, mentioned: 500, score: 500 / 2000, cited: 1, citedRate: 1 / 12 });
    const current = totals({ total: 2000, mentioned: 500, score: 500.5 / 2000, cited: 1, citedRate: 1 / 12 });
    expect(aiSentence({ current, previous, trend })).toBe("Nothing moved since Oct 28.");
  });

  it("is calm when nothing moved", () => {
    expect(aiSentence({ current: totals(), previous: totals(), trend })).toBe("Nothing moved since Oct 28.");
  });
});

describe("platformCount", () => {
  it("says failures beside the count", () => {
    expect(platformCount({ mentioned: 1, total: 2 })).toBe("1 of 2 answers");
    expect(platformCount({ mentioned: 1, total: 2 }, 1)).toBe("1 of 2 answers · 1 failed");
    expect(platformCount({ mentioned: 0, total: 0 }, 3)).toBe("No answers · 3 failed");
  });
});

describe("aiFigures", () => {
  const sov = (share: number | null, rivals = 2) => [{ domain: "you.com", own: true, answers: 3, cited: 1, sov: share, rate: 0.25 }, ...Array.from({ length: rivals }, (_, i) => ({ domain: `r${i}.com`, own: false, answers: 1, cited: 0, sov: 0.1, rate: 0.1 }))];

  it("says how many failed under Visibility", () => {
    const [visibility] = aiFigures({ current: totals({ score: 0.25 }), previous: totals({ score: 0.2 }), sov: sov(0.5), previousSov: sov(0.4), trend, failed: 2 }, "/projects/1/settings");
    expect(visibility).toMatchObject({ caption: "3 of 12 answers name you · 2 failed, vs Oct 28" });
  });

  it("moves rates in points and reads position as better or worse", () => {
    const [visibility, cited, share, position] = aiFigures(
      { current: totals({ score: 0.25, avgPosition: 2 }), previous: totals({ score: 0.2, avgPosition: 3.4 }), sov: sov(0.5), previousSov: sov(0.4), trend },
      "/projects/1/settings",
    );
    expect(visibility).toMatchObject({ value: "25.0%", delta: { text: "+5 pts", tone: "good" }, caption: "3 of 12 answers name you, vs Oct 28" });
    expect(cited).toMatchObject({ value: "8.3%", caption: "1 answer links to you, vs Oct 28" });
    expect(share).toMatchObject({ value: "50.0%", delta: { tone: "good" }, caption: "against 2 competitors, vs Oct 28" });
    expect(position).toMatchObject({ label: "Position when named", value: "2.0", delta: { text: "1.4 better", tone: "good", up: true }, caption: "1 is named first, vs Oct 28" });
  });

  it("has no change on the first run, and leaves saying so to the sentence", () => {
    const figures = aiFigures({ current: totals(), previous: null, sov: sov(0.5), previousSov: null, trend: trend.slice(1) }, "/x");
    for (const f of figures) expect(f).toMatchObject({ state: "value", delta: null });
    expect(figures.map((f) => f.caption)).toEqual(["3 of 12 answers name you", "1 answer links to you", "against 2 competitors", "1 is named first"]);
  });

  it("gives a reason and a next step in place of a number", () => {
    const figures = aiFigures({ current: totals({ avgPosition: null, mentioned: 0 }), previous: null, sov: sov(null, 0), previousSov: null, trend: trend.slice(1) }, "/projects/1/settings");
    expect(figures[2]).toMatchObject({ state: "empty", action: { href: "/projects/1/settings" } });
    expect(figures[3]).toMatchObject({ state: "empty", text: "Not named in any answer yet." });
  });

  it("doesn't say never when the newest run got nothing back", () => {
    const [, , , position] = aiFigures({ current: totals({ avgPosition: null, mentioned: 0 }), previous: null, sov: sov(0.5), previousSov: null, trend, failedRun: "2026-11-09 07:00" }, "/x");
    expect(position).toMatchObject({ state: "empty", text: "Not named in the latest answers." });
  });

  it("doesn't say never when earlier runs named you", () => {
    const position = (current: Overview["current"], previous: Overview["previous"]) => aiFigures({ current, previous, sov: sov(0.5), previousSov: null, trend }, "/x")[3];
    const unnamed = totals({ avgPosition: null, mentioned: 0 });
    expect(position(unnamed, totals({ avgPosition: 3 }))).toMatchObject({ state: "empty", text: "Not named in the latest run. You were at 3.0 on Oct 28." });
    expect(position(unnamed, totals({ avgPosition: null, mentioned: 0 }))).toMatchObject({ state: "empty", text: "Not named in the latest run." });
    expect(position(totals({ avgPosition: null, mentioned: 2 }), totals())).toMatchObject({ state: "empty", text: "The latest answers name you without a position." });
  });
});

describe("trendChart", () => {
  const brands = [
    { domain: "you.com", name: "You Inc", own: true },
    { domain: "rival.com", name: "Rival", own: false },
    { domain: "quiet.com", name: "Quiet", own: false },
  ] as Overview["brands"];
  const points = [
    { date: "2026-11-02 23:53", visibility: 20, "you.com": 20, "rival.com": 0, "quiet.com": 0 },
    { date: "2026-11-03 07:00", visibility: 25, "you.com": 25, "rival.com": null, "quiet.com": 0 },
    { date: "2026-11-04 07:00", visibility: 30, "you.com": 30, "rival.com": 10, "quiet.com": 0 },
  ];

  it("draws you and every competitor named at least once, and counts the rest", () => {
    const { series, neverNamed } = trendChart({ brands, trend: points });
    expect(series).toEqual([
      { key: "visibility", label: "You" },
      { key: "rival.com", label: "Rival", role: "context" },
    ]);
    expect(neverNamed).toBe(1);
  });

  it("keeps the break at a missing run and the run's wall clock", () => {
    const { rows } = trendChart({ brands, trend: points });
    expect(rows[1]["rival.com"]).toBeNull();
    expect(rows[0]).toMatchObject({ date: "2026-11-02T23:53Z", label: "Nov 2, 11:53 PM", visibility: 20 });
    expect(rows[0]).not.toHaveProperty("quiet.com");
  });
});

const prompt = (over: Partial<Parameters<typeof promptsSentence>[0][number]> = {}) => ({ active: true, branded: false, mentionedOn: 0, citedOn: 0, checkedOn: 4, ...over });

describe("promptsSentence", () => {
  it("covers no prompts, all paused and nothing asked yet", () => {
    expect(promptsSentence([])).toBe("No prompts yet.");
    expect(promptsSentence([prompt({ active: false })])).toBe("Every prompt is paused, so nothing is being asked.");
    expect(promptsSentence([prompt({ checkedOn: 0 }), prompt({ checkedOn: 0 })])).toBe("Two prompts waiting for the first run.");
  });

  it("leaves branded prompts out when there are others", () => {
    const rows = [prompt({ mentionedOn: 2 }), prompt(), prompt({ branded: true, mentionedOn: 4 })];
    expect(promptsSentence(rows)).toBe("At least one assistant names you for 1 of 2 prompts that don't name your brand.");
  });

  it("counts everything when every prompt is branded", () => {
    expect(promptsSentence([prompt({ branded: true, mentionedOn: 1 })])).toBe("At least one assistant names you for 1 of 1 prompt.");
  });

  it("says so when nobody names you, and what's still waiting", () => {
    expect(promptsSentence([prompt(), prompt({ checkedOn: 0 })])).toBe("No assistant names you yet across 1 prompt. One prompt is waiting for a first answer.");
  });
});

describe("promptsFigures", () => {
  it("counts over the active prompts that have answers", () => {
    const rows = [prompt({ mentionedOn: 1, citedOn: 1 }), prompt(), prompt({ checkedOn: 0, branded: true }), prompt({ active: false, mentionedOn: 4 })];
    const [active, named, cited, waiting] = promptsFigures(rows);
    expect(active).toMatchObject({ value: "3", caption: "1 branded, 1 paused" });
    expect(named).toMatchObject({ value: "1 of 2" });
    expect(cited).toMatchObject({ value: "1 of 2" });
    expect(waiting).toMatchObject({ value: "1" });
  });
});

const answer = (platform: string, day: string, named: boolean, over: Partial<PromptAnswer> = {}): PromptAnswer => ({ platform, day, named, cited: false, position: named ? 2 : null, ...over });

describe("promptSentence", () => {
  it("has no answers yet", () => {
    expect(promptSentence([])).toBe("No answers yet. This prompt is asked in the next run.");
    expect(promptSentence([], false)).toBe("This prompt is paused, and has no answers yet.");
  });

  it("says what the first answers found", () => {
    expect(promptSentence([answer("ChatGPT", "Nov 4", true), answer("Gemini", "Nov 4", false)])).toBe("First answers on Nov 4: 1 of 2 assistants names you. Changes show after the next run.");
  });

  it("names who started and who stopped", () => {
    const history = [answer("ChatGPT", "Nov 4", true), answer("Gemini", "Nov 4", false), answer("ChatGPT", "Oct 28", false), answer("Gemini", "Oct 28", true)];
    expect(promptSentence(history)).toBe("ChatGPT started naming you and Gemini stopped, compared with Oct 28.");
    expect(promptSentence([answer("ChatGPT", "Nov 4", false), answer("ChatGPT", "Oct 28", true)])).toBe("ChatGPT stopped naming you, compared with Oct 28.");
  });

  it("falls back to citations, then to nothing", () => {
    expect(promptSentence([answer("Claude", "Nov 4", true, { cited: true }), answer("Claude", "Oct 28", true)])).toBe("Claude started citing you, compared with Oct 28.");
    expect(promptSentence([answer("Claude", "Nov 4", true), answer("Claude", "Oct 28", true)])).toBe("Nothing moved since Oct 28.");
  });
});

describe("promptFigures", () => {
  it("shows small counts as a plain difference and position as better or worse", () => {
    const history = [answer("ChatGPT", "Nov 4", true, { position: 1 }), answer("Gemini", "Nov 4", true, { position: 1 }), answer("ChatGPT", "Oct 28", true, { position: 3 }), answer("Gemini", "Oct 28", false)];
    const [named, , position, overview] = promptFigures(history, { present: true, cited: true, keyword: "best plumber", day: "Nov 3" }, true);
    expect(named).toMatchObject({ value: "2 of 2", delta: { text: "+1" }, caption: "assistants in the latest answers, vs Oct 28" });
    expect(position).toMatchObject({ value: "1.0", delta: { text: "2 better", tone: "good" } });
    expect(overview).toMatchObject({ value: "Cites you", caption: "for “best plumber”, Nov 3" });
  });

  it("moves position only on assistants placed in both runs", () => {
    const placed = (platform: string, day: string, position: number) => answer(platform, day, true, { position });
    const steady = [placed("ChatGPT", "Nov 4", 2), placed("Gemini", "Nov 4", 2), placed("ChatGPT", "Oct 28", 2), placed("Gemini", "Oct 28", 2)];
    // A new assistant at 8: the mean is 4.0, but no assistant's answer got worse.
    expect(promptFigures([placed("Claude", "Nov 4", 8), ...steady], null, false)[2]).toMatchObject({ value: "4.0", delta: { tone: "muted" } });
    // An assistant that only now names you, at 8: the same.
    expect(promptFigures([placed("ChatGPT", "Nov 4", 2), placed("Gemini", "Nov 4", 8), placed("ChatGPT", "Oct 28", 2), answer("Gemini", "Oct 28", false)], null, false)[2]).toMatchObject({ value: "5.0", delta: { tone: "muted" } });
    // Nobody placed twice: nothing to compare.
    expect(promptFigures([placed("ChatGPT", "Nov 4", 2), answer("ChatGPT", "Oct 28", false)], null, false)[2]).toMatchObject({ value: "2.0", delta: null });
  });

  it("leaves out an assistant whose latest answer failed, rather than counting its older answer, and says so", () => {
    const history = [answer("ChatGPT", "Nov 9", false, { failed: true }), answer("Gemini", "Nov 9", true), answer("ChatGPT", "Nov 3", true), answer("Gemini", "Nov 3", true)];
    const [named, cited] = promptFigures(history, null, false);
    expect(named).toMatchObject({ value: "1 of 1", delta: { text: "No change" }, caption: "assistants in the latest answers · 1 failed, vs Nov 3" });
    expect(cited).toMatchObject({ value: "0 of 1" });
    expect(promptSentence(history)).toBe("Nothing moved since Nov 3.");
  });

  it("compares with the answer before, past an older one that failed", () => {
    const history = [answer("Gemini", "Nov 9", true), answer("Gemini", "Nov 3", false, { failed: true }), answer("Gemini", "Oct 27", false)];
    expect(promptSentence(history)).toBe("Gemini started naming you, compared with Oct 27.");
  });

  it("explains an empty position and overview", () => {
    const figures = promptFigures([answer("ChatGPT", "Nov 4", false)], null, false);
    expect(figures[0]).toMatchObject({ value: "0 of 1", delta: null, caption: "assistants in the latest answers" });
    expect(figures[1]).toMatchObject({ caption: "assistants linking to you" });
    expect(figures[2]).toMatchObject({ state: "empty" });
    expect(figures[3]).toMatchObject({ state: "empty", text: "No keyword set, so it isn't checked." });
    expect(promptFigures([], null, true)[3]).toMatchObject({ text: "Not checked yet. It's checked with the next run." });
  });
});

describe("sources", () => {
  const domains = [
    { ownership: "yours" as const, citations: 2, withoutUs: 0 },
    { ownership: "competitor" as const, citations: 5, withoutUs: 3 },
    { ownership: "third_party" as const, citations: 4, withoutUs: 1 },
    { ownership: "third_party" as const, citations: 1, withoutUs: 0 },
  ];

  it("says who's cited and where you're missing", () => {
    expect(sourcesSentence({ answers: 0, domains: [] })).toBe("No answer cites a site yet.");
    expect(sourcesSentence({ answers: 12, domains })).toBe("The latest 12 answers cite four sites. Your site is cited twice, and one third-party site appears in answers that don't name you.");
    expect(sourcesSentence({ answers: 1, domains: [{ ownership: "third_party", citations: 1, withoutUs: 0 }] })).toBe("The latest answer cites one site. Your site isn't cited yet.");
  });

  it("adds the citations up by owner", () => {
    const [sites, yours, rivals, outreach] = sourcesFigures({ answers: 12, domains });
    expect(sites).toMatchObject({ value: "4", caption: "in the latest 12 answers" });
    expect(yours).toMatchObject({ value: "2", caption: "of 12 citations" });
    expect(rivals).toMatchObject({ value: "5" });
    expect(outreach).toMatchObject({ value: "1" });
  });
});

describe("brands", () => {
  it("covers no competitors, no answers, nothing to suggest, and suggestions", () => {
    expect(brandsSentence({ competitors: 0, aliases: 0, answers: 0, suggestions: 0 })).toBe("SEOpen looks for you in AI answers, with no competitors yet. Suggestions appear once tracked prompts have been answered.");
    expect(brandsSentence({ competitors: 1, aliases: 0, answers: 8, suggestions: 0 })).toBe("SEOpen looks for you and one competitor in AI answers. No untracked site is cited often enough to suggest.");
    expect(brandsSentence({ competitors: 2, aliases: 0, answers: 8, suggestions: 3 })).toBe("SEOpen looks for you and two competitors in AI answers. Three more sites are cited often enough to consider.");
  });

  it("counts you among the tracked brands", () => {
    const [brands, aliases, suggested] = brandsFigures({ competitors: 2, aliases: 4, answers: 8, suggestions: 1 });
    expect(brands).toMatchObject({ value: "3", caption: "you and 2 competitors" });
    expect(aliases).toMatchObject({ value: "4" });
    expect(suggested).toMatchObject({ value: "1", caption: "cited in two or more of 8 answers" });
  });
});
