import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { BALANCE_FLOOR_USD, balanceAlertMessage, balanceProblems, balanceThresholdUsd, configuredThresholdUsd, dailyPaceUsd, isDailyLimit, isPaymentRequired } = await import("./balance");

describe("the balance alert threshold", () => {
  it("is a week at the platform cap's pace when nothing spends faster", () => {
    expect(dailyPaceUsd({ capUsd: 100, weekCostUsd: 7 })).toBeCloseTo(100 / 30);
    expect(balanceThresholdUsd({ capUsd: 100, weekCostUsd: 7, configuredUsd: null })).toBeCloseTo(23.33, 2);
  });

  it("follows the last week's spend when it runs faster than the cap's pace", () => {
    expect(dailyPaceUsd({ capUsd: 100, weekCostUsd: 35 })).toBe(5);
    expect(balanceThresholdUsd({ capUsd: 100, weekCostUsd: 35, configuredUsd: null })).toBe(35);
  });

  it("never drops below the floor, with no cap and no spend", () => {
    expect(balanceThresholdUsd({ capUsd: null, weekCostUsd: 0, configuredUsd: null })).toBe(BALANCE_FLOOR_USD);
  });

  it("uses a configured figure instead, when one is set", () => {
    expect(balanceThresholdUsd({ capUsd: 100, weekCostUsd: 35, configuredUsd: 60 })).toBe(60);
    expect(configuredThresholdUsd("60")).toBe(60);
    expect(configuredThresholdUsd(" 12.5 ")).toBe(12.5);
    for (const raw of [undefined, "", "  ", "lots", "-5", "Infinity"]) expect(configuredThresholdUsd(raw), String(raw)).toBeNull();
  });
});

describe("isDailyLimit", () => {
  it("is DataForSEO's 40203 only", () => {
    expect(isDailyLimit(40203)).toBe(true);
    for (const code of [undefined, 402, 40200, 40210, 20000, 429]) expect(isDailyLimit(code)).toBe(false);
  });
});

describe("isPaymentRequired", () => {
  it("reads HTTP 402 and DataForSEO's own payment codes", () => {
    for (const code of [402, 40200, 40210]) expect(isPaymentRequired(code)).toBe(true);
    for (const code of [200, 401, 429, 500, 20000, 40100, 40203]) expect(isPaymentRequired(code)).toBe(false);
  });
});

const URL = "https://app.getseopen.com/admin/health";

describe("balanceAlertMessage", () => {
  it("says a low balance, the threshold, the pace and what stops when it runs out", () => {
    const m = balanceAlertMessage({ kind: "low", balanceUsd: 12.5, thresholdUsd: 23.33, paceUsd: 100 / 30, at: new Date("2026-11-09T08:00:00Z"), url: URL });
    expect(m.subject).toBe("SEOpen: DataForSEO balance is low, $12.50 left");
    expect(m.text).toContain("DataForSEO's balance is $12.50, below the $23.33 alert threshold.");
    expect(m.text).toContain("about 3 days");
    expect(m.text).toContain("$3.33 a day");
    expect(m.text).toContain("HTTP 402");
    expect(m.text).toContain("rank checks");
    expect(m.text).toContain("https://app.dataforseo.com");
    expect(m.text).toContain(URL);
    expect(m.text).not.toMatch(/—/);
  });

  it("says calls are failing when the balance is already used up", () => {
    const m = balanceAlertMessage({ kind: "low", balanceUsd: -0.24, thresholdUsd: 23.33, paceUsd: 3.33, at: new Date("2026-11-09T08:00:00Z"), url: URL });
    expect(m.subject).toBe("SEOpen: DataForSEO balance is used up (-$0.24), paid calls are failing");
    expect(m.text).toContain("DataForSEO's balance is -$0.24, so every paid call fails");
    expect(m.text).not.toContain("about");
  });

  it("says a 402 was seen, where and when, and the last balance read", () => {
    const m = balanceAlertMessage({
      kind: "payment",
      endpoint: "backlinks/summary/live",
      at: new Date("2026-11-09T14:03:00Z"),
      last: { balanceUsd: 4.1, checkedAt: "2026-11-09T08:00:00.000Z" },
      url: URL,
    });
    expect(m.subject).toBe("SEOpen: DataForSEO refused a paid call for payment, paid calls are failing");
    expect(m.text).toContain("HTTP 402 (payment required) on backlinks/summary/live at 2026-11-09 14:03 UTC");
    expect(m.text).toContain("The last balance check, at 2026-11-09 08:00 UTC, read $4.10.");
    expect(m.text).toContain("at most once a day");
    expect(m.html).toContain("<p>");
    expect(m.html).not.toContain("<script");
  });

  it("says the daily limit was reached, where, and when it resets", () => {
    const m = balanceAlertMessage({ kind: "limit", endpoint: "a/live", at: new Date("2026-11-09T14:03:00Z"), url: URL });
    expect(m.subject).toBe("SEOpen: DataForSEO's daily spend limit is reached, paid calls are failing until 00:00 UTC");
    expect(m.text).toContain("40203 (cost limit exceeded) on a/live at 2026-11-09 14:03 UTC");
    expect(m.text).toContain("under Settings");
  });

  it("escapes what goes into the HTML", () => {
    const m = balanceAlertMessage({ kind: "payment", endpoint: "a/<b>", at: new Date("2026-11-09T14:03:00Z"), last: null, url: URL });
    expect(m.html).toContain("a/&lt;b&gt;");
    expect(m.text).not.toContain("The last balance check");
  });
});

describe("balanceProblems", () => {
  const now = new Date("2026-11-09T15:00:00Z");
  const fine = { checkedAt: "2026-11-09T08:00:00.000Z", balanceUsd: 40, thresholdUsd: 23.33, low: false };
  const low = { ...fine, balanceUsd: 12, low: true };

  it("has nothing when the last check was fine and no 402 came after it", () => {
    expect(balanceProblems({ check: fine, payment: null }, now)).toEqual([]);
    expect(balanceProblems({ check: fine, payment: { at: "2026-11-09T07:00:00.000Z", endpoint: "x" } }, now)).toEqual([]);
    expect(balanceProblems({ check: null, payment: null }, now)).toEqual([]);
  });

  it("shows a low last check", () => {
    expect(balanceProblems({ check: low, payment: null }, now)).toEqual([
      { problem: "Low", detail: "$12.00 left at the last check, under the $23.33 alert threshold", at: low.checkedAt },
    ]);
    expect(balanceProblems({ check: { ...low, balanceUsd: -0.24 }, payment: null }, now)[0]).toMatchObject({ problem: "Used up" });
  });

  it("shows a 402 from the last day that no check has answered", () => {
    const payment = { at: "2026-11-09T14:00:00.000Z", endpoint: "backlinks/summary/live" };
    expect(balanceProblems({ check: fine, payment }, now)).toEqual([
      { problem: "Payment required", detail: "DataForSEO answered HTTP 402 on backlinks/summary/live, so paid calls are failing", at: payment.at },
    ]);
    expect(balanceProblems({ check: null, payment }, now)).toHaveLength(1);
    expect(balanceProblems({ check: low, payment }, now)).toHaveLength(2);
  });

  it("shows a 40203 for the rest of its UTC day, and not after", () => {
    const limit = { at: "2026-11-09T13:00:00.000Z", endpoint: "serp/google/organic/task_post" };
    expect(balanceProblems({ check: fine, payment: null, limit }, now)).toEqual([
      {
        problem: "Daily limit reached",
        detail: "DataForSEO answered 40203 on serp/google/organic/task_post: its daily spend limit is reached, so paid calls fail until 00:00 UTC",
        at: limit.at,
      },
    ]);
    expect(balanceProblems({ check: fine, payment: null, limit: { ...limit, at: "2026-11-08T23:59:00.000Z" } }, now)).toEqual([]);
  });

  it("drops a 402 older than a day", () => {
    expect(balanceProblems({ check: null, payment: { at: "2026-11-08T14:59:00.000Z", endpoint: "x" } }, now)).toEqual([]);
  });
});
