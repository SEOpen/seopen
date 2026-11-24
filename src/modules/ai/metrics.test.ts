import { describe, expect, it } from "vitest";
import type { AiBrandMention } from "@/db/schema/ai";
import { answeredPerPair, citedByRun, deltaPoints, failedPerPlatform, latestPerPair, shareOfVoice, visibility, visibilityByPlatform, withFailedPlatforms, withoutFailedRuns, type AnswerRow } from "./metrics";
import { keywordToPrompt, monthlyCost, promptToKeyword, ratesFrom, roundUsd, runCost } from "./prompts";

const m = (domain: string, count: number, own = false, cited = false): AiBrandMention => ({
  domain,
  own,
  count,
  cited,
  firstOffset: count ? 0 : null,
  position: null,
});

const row = (promptId: number, platform: string, mentions: AiBrandMention[], at = "2026-10-26", position: number | null = null): AnswerRow => {
  const own = mentions.find((x) => x.own);
  return { promptId, platform, mentions, mentioned: (own?.count ?? 0) > 0, cited: own?.cited ?? false, position, at };
};

const rows: AnswerRow[] = [
  row(1, "chat_gpt", [m("us.com", 2, true, true), m("a.com", 1), m("b.com", 0)], undefined, 2),
  row(1, "perplexity", [m("us.com", 0, true), m("a.com", 1), m("b.com", 1)]),
  row(2, "chat_gpt", [m("us.com", 1, true), m("a.com", 0), m("b.com", 0)], undefined, 1),
  row(2, "perplexity", [m("us.com", 0, true), m("a.com", 0), m("b.com", 0)]),
];
const brands = [
  { domain: "us.com", own: true },
  { domain: "a.com", own: false },
  { domain: "b.com", own: false },
];

describe("visibility", () => {
  it("is the share of answers that mention us", () => {
    const v = visibility(rows);
    expect(v).toMatchObject({ total: 4, mentioned: 2, cited: 1, score: 0.5, citedRate: 0.25, avgPosition: 1.5 });
  });

  it("is null with no answers", () => {
    expect(visibility([]).score).toBeNull();
  });

  it("splits by platform in the given order and skips empty platforms", () => {
    const v = visibilityByPlatform(rows, ["perplexity", "gemini", "chat_gpt"]);
    expect(v.map((x) => [x.platform, x.score])).toEqual([
      ["perplexity", 0],
      ["chat_gpt", 1],
    ]);
  });
});

describe("share of voice", () => {
  it("counts each answer once per brand mentioned", () => {
    const s = shareOfVoice(rows, brands);
    // us: 2 answers, a: 2, b: 1 → 5 total
    expect(s.map((x) => [x.domain, x.answers, x.sov])).toEqual([
      ["us.com", 2, 2 / 5],
      ["a.com", 2, 2 / 5],
      ["b.com", 1, 1 / 5],
    ]);
    expect(s[0].cited).toBe(1);
    expect(s[0].rate).toBe(0.5);
  });

  it("sums to 1 across tracked brands", () => {
    const total = shareOfVoice(rows, brands).reduce((n, x) => n + (x.sov ?? 0), 0);
    expect(total).toBeCloseTo(1);
  });

  it("ignores brands that are not tracked any more", () => {
    const s = shareOfVoice(rows, [brands[0], brands[1]]);
    expect(s.map((x) => x.sov)).toEqual([0.5, 0.5]);
  });

  it("is null when nobody is mentioned", () => {
    expect(shareOfVoice([rows[3]], brands).every((x) => x.sov === null)).toBe(true);
  });
});

describe("latest per prompt × platform", () => {
  it("keeps only the newest answer", () => {
    const older = { ...rows[0], at: "2026-10-19", mentioned: false };
    const latest = latestPerPair([older, rows[0], rows[1]]);
    expect(latest).toHaveLength(2);
    expect(latest.find((r) => r.platform === "chat_gpt")!.mentioned).toBe(true);
  });
});

describe("deltaPoints", () => {
  it("returns percentage points", () => {
    expect(deltaPoints(0.5, 0.25)).toBe(25);
    expect(deltaPoints(0.333, 0.5)).toBe(-16.7);
    expect(deltaPoints(0.5, null)).toBeNull();
  });
});

describe("prompt helpers", () => {
  it.each([
    ["best mac journal", "What is the best mac journal?"],
    ["best shared notes apps", "What are the best shared notes apps?"],
    ["how to set up shared notes on mac", "How do I set up shared notes on mac?"],
    ["notes engine alternatives", "What are the best alternatives to notes engine?"],
    ["margin vs gammanest", "Which is better, margin or gammanest?"],
    ["what is a shared notebook", "What is a shared notebook?"],
    ["handwritten notes mac", "What is the best handwritten notes mac?"],
    ["canvas", "What is the best canvas?"],
    ["journals for macos", "What are the best journals for macos?"],
  ])("keywordToPrompt(%s)", (kw, prompt) => {
    expect(keywordToPrompt(kw)).toBe(prompt);
  });

  it.each([
    ["What are the best journal apps for Mac in 2026?", "best journal apps for mac"],
    ["How do I set up shared notes on macOS?", "set up shared notes on macos"],
    ["Which is better, Margin or Gammanest?", "margin vs gammanest"],
    ["Can you recommend a good travel journal?", "travel journal"],
  ])("promptToKeyword(%s)", (prompt, kw) => {
    expect(promptToKeyword(prompt)).toBe(kw);
  });

  it("estimates run and monthly cost from observed rates", () => {
    const rates = ratesFrom({ chat_gpt: 0.02, perplexity: null });
    expect(rates.perAnswer.chat_gpt).toBe(0.02);
    expect(rates.perAnswer.perplexity).toBe(0.006);
    const prompts = [
      { platforms: ["chat_gpt", "perplexity"], keyword: "x" },
      { platforms: ["chat_gpt"], keyword: null },
    ];
    expect(runCost(prompts, rates)).toBeCloseTo(0.02 + 0.006 + 0.0012 + 0.02);
    expect(monthlyCost(prompts, rates)).toBeCloseTo(runCost(prompts, rates) * (52 / 12));
  });
});

describe("roundUsd", () => {
  it("rounds to cents from $0.10 and to a tenth of a cent below", () => {
    expect(roundUsd(1.08224)).toBe(1.08);
    expect(roundUsd(0.2498)).toBe(0.25);
    expect(roundUsd(0.02561)).toBe(0.026);
  });
});

describe("citedByRun", () => {
  const row = (runId: number, promptId: number, cited: boolean) => ({
    runId,
    promptId,
    platform: "chat_gpt",
    mentioned: cited,
    cited,
    position: null,
    mentions: [],
    at: `2026-10-${String(10 + runId)}T00:00:00.000Z#${String(runId).padStart(8, "0")}`,
  });

  it("counts the state after each run, so a prompt not asked again keeps its latest answer", () => {
    const rows = [row(1, 1, true), row(1, 2, false), row(2, 2, true), row(3, 1, false)];
    expect(citedByRun(rows).map((p) => p.cited)).toEqual([1, 2, 1]);
    expect(citedByRun(rows)[0].at).toBe("2026-10-11T00:00:00.000Z");
  });

  it("keeps only the last runs", () => {
    const rows = [row(1, 1, false), row(2, 1, true), row(3, 1, true)];
    expect(citedByRun(rows, 2).map((p) => p.at.slice(0, 10))).toEqual(["2026-10-12", "2026-10-13"]);
  });

  it("doesn't count last week's answer for a pair whose newest answer failed", () => {
    const rows = [row(1, 1, true), row(1, 2, true), row(2, 1, true), { ...row(2, 2, false), cited: null, mentioned: null, failed: true }];
    expect(citedByRun(rows).map((p) => p.cited)).toEqual([2, 1]);
  });
});

describe("answeredPerPair", () => {
  const answer = (promptId: number, at: string, mentioned: boolean, failed = false) => ({ promptId, platform: "chat_gpt", at, mentioned: failed ? null : mentioned, cited: null, position: null, mentions: null, failed });

  it("leaves out a pair whose newest answer failed, rather than counting its older answer or a miss", () => {
    const rows = [answer(1, "a", true), answer(2, "a", true), answer(1, "b", false, true), answer(2, "b", false)];
    expect(answeredPerPair(rows).map((r) => [r.promptId, r.at])).toEqual([[2, "b"]]);
    expect(visibility(answeredPerPair(rows))).toMatchObject({ total: 1, mentioned: 0, score: 0 });
  });

  it("counts the pair again once a later answer comes back", () => {
    expect(answeredPerPair([answer(1, "a", true, true), answer(1, "b", true)]).map((r) => r.at)).toEqual(["b"]);
  });
});

describe("withoutFailedRuns", () => {
  it("drops a run where every answer failed, and keeps one that got any answer back", () => {
    const rows = [
      { runId: 1, failed: false },
      { runId: 2, failed: true },
      { runId: 2, failed: true },
      { runId: 3, failed: true },
      { runId: 3, failed: false },
    ];
    expect(withoutFailedRuns(rows).map((r) => r.runId)).toEqual([1, 3, 3]);
  });
});

describe("failed answers", () => {
  const finished = (promptId: number, platform: string, at: string, failed: boolean) => ({ promptId, platform, at, failed });

  it("counts a pair whose newest answer failed, per platform", () => {
    expect(failedPerPlatform([finished(1, "gemini", "b", true), finished(2, "gemini", "b", true), finished(1, "claude", "b", true), finished(1, "chat_gpt", "b", false)])).toEqual({ gemini: 2, claude: 1 });
  });

  it("stops counting it once it's been answered, and starts when a later one fails", () => {
    expect(failedPerPlatform([finished(1, "gemini", "a", true), finished(1, "gemini", "b", false)])).toEqual({});
    expect(failedPerPlatform([finished(1, "gemini", "a", false), finished(1, "gemini", "b", true)])).toEqual({ gemini: 1 });
  });

  it("keeps a platform in the list that has only failures, in its place", () => {
    const answered = visibilityByPlatform([{ promptId: 1, platform: "chat_gpt", at: "a", mentioned: true, cited: false, position: null, mentions: null }], ["chat_gpt", "gemini", "claude"]);
    const rows = withFailedPlatforms(answered, { gemini: 1 }, ["gemini", "chat_gpt", "claude"]);
    expect(rows.map((r) => [r.platform, r.total])).toEqual([
      ["gemini", 0],
      ["chat_gpt", 1],
    ]);
  });
});
