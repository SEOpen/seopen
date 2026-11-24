import { inArray, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The DataForSEO balance alert against seopen_test: the daily check records what it read and emails
 * the owner when the balance is low, and the first HTTP 402 emails at once. Each goes at most once a
 * day, and a 402 alert covers that day's low alert. A 40203 (DataForSEO's daily spend limit) emails
 * once a day on its own. The balance read and the send are stubbed, so
 * nothing reaches DataForSEO or Resend. Every test runs on its own made-up day far in the future, so
 * its claims are its own; the two state rows are put back as they were afterwards.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string; html: string }[]);
const mail = vi.hoisted(() => ({ failing: false, configured: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  emailConfigured: () => mail.configured,
  sendEmail: async (msg: { to: string; subject: string; text: string; html: string }) => {
    if (mail.failing) throw new Error("Resend rejected the message");
    sent.push(msg);
  },
}));

/** Owner alerts need an address now that core has no default one. */
const ALERT_TO = "owner@example.com";
vi.stubEnv("OWNER_ALERT_EMAIL", ALERT_TO);

const ready = await testDb();

const { db } = await import("@/db");
const { settings } = await import("@/db/schema");
const { BALANCE_CHECK_KEY, DAILY_LIMIT_KEY, PAYMENT_REQUIRED_KEY, balanceAlertKey, checkDataForSEOBalance, noteDailyLimit, notePaymentRequired, readBalanceState } = await import("./balance");

/** A day no real alert uses: year 2900 plus a random day, a new one for each test. */
let base = Date.UTC(2900, 0, 1) + Math.floor(Math.random() * 20_000) * 86_400_000;
const days: string[] = [];
function newDay(): Date {
  base += 86_400_000 * 3;
  const at = new Date(base + 9 * 3_600_000);
  days.push(at.toISOString().slice(0, 10));
  return at;
}
const minutes = (at: Date, n: number) => new Date(at.getTime() + n * 60_000);

function check(at: Date, balanceUsd: number, configured: string | undefined = undefined) {
  return checkDataForSEOBalance({ readBalance: async () => balanceUsd, cap: async () => 100, weekCostUsd: async () => 7, now: () => at, configured });
}

describe.skipIf(!ready)("the DataForSEO balance alert", () => {
  let saved: { key: string; value: unknown }[] = [];

  beforeAll(async () => {
    saved = await db.select().from(settings).where(inArray(settings.key, [BALANCE_CHECK_KEY, PAYMENT_REQUIRED_KEY, DAILY_LIMIT_KEY]));
  });

  beforeEach(() => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
  });

  afterAll(async () => {
    for (const day of days) await db.delete(settings).where(like(settings.key, `platform.dfs_balance_alert:${day}:%`));
    await db.delete(settings).where(inArray(settings.key, [BALANCE_CHECK_KEY, PAYMENT_REQUIRED_KEY, DAILY_LIMIT_KEY]));
    if (saved.length) await db.insert(settings).values(saved);
  });

  it("records a healthy balance and sends nothing", async () => {
    const at = newDay();
    expect(await check(at, 80)).toMatchObject({ balanceUsd: 80, low: false, emailed: false });
    expect(sent).toEqual([]);
    const { check: stored } = await readBalanceState();
    expect(stored).toMatchObject({ balanceUsd: 80, low: false, checkedAt: at.toISOString() });
    expect(stored!.thresholdUsd).toBeCloseTo(23.33, 2);
  });

  it("emails a low balance to the owner once a day, and again the next day", async () => {
    const at = newDay();
    expect(await check(at, 12)).toMatchObject({ low: true, emailed: true });
    expect(await check(minutes(at, 60), 11)).toMatchObject({ low: true, emailed: false });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ALERT_TO);
    expect(sent[0].subject).toBe("SEOpen: DataForSEO balance is low, $12.00 left");
    expect((await readBalanceState()).check).toMatchObject({ balanceUsd: 11, low: true });

    expect(await check(newDay(), 10)).toMatchObject({ emailed: true });
    expect(sent).toHaveLength(2);
  });

  it("takes a configured threshold over the computed one", async () => {
    expect(await check(newDay(), 40, "50")).toMatchObject({ thresholdUsd: 50, low: true, emailed: true });
  });

  it("claims nothing without Resend, so a later check with it can still send", async () => {
    const at = newDay();
    mail.configured = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await check(at, 5)).toMatchObject({ low: true, emailed: false });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("RESEND_API_KEY"));
    warn.mockRestore();
    mail.configured = true;
    expect(await check(minutes(at, 5), 5)).toMatchObject({ emailed: true });
  });

  it("gives the claim back when the send fails", async () => {
    const at = newDay();
    mail.failing = true;
    await expect(check(at, 5)).rejects.toThrow("Resend rejected");
    mail.failing = false;
    expect(await check(minutes(at, 5), 5)).toMatchObject({ emailed: true });
  });

  it("emails on the first 402 and records it, then stays quiet for the rest of the day", async () => {
    const at = newDay();
    await check(minutes(at, -60), 4.1);
    sent.length = 0;
    await notePaymentRequired("backlinks/summary/live", at);
    await notePaymentRequired("backlinks/summary/live", minutes(at, 5));
    await notePaymentRequired("rank/task_post", minutes(at, 120));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("SEOpen: DataForSEO refused a paid call for payment, paid calls are failing");
    expect(sent[0].text).toContain("backlinks/summary/live");
    expect(sent[0].text).toContain("read $4.10");
    // The last 402 is what Health reads, once a minute at most.
    expect((await readBalanceState()).payment).toEqual({ at: minutes(at, 120).toISOString(), endpoint: "rank/task_post" });
    // The day's low alert is covered by the 402 one.
    expect(await check(minutes(at, 180), -0.24)).toMatchObject({ low: true, emailed: false });
    expect(sent).toHaveLength(1);
  });

  it("skips the database for further 402s in the same minute", async () => {
    const at = newDay();
    await notePaymentRequired("a/live", at);
    await notePaymentRequired("b/live", minutes(at, 0.5));
    expect((await readBalanceState()).payment).toEqual({ at: at.toISOString(), endpoint: "a/live" });
  });

  it("records a 402 without Resend, and never throws", async () => {
    const at = newDay();
    mail.configured = false;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(notePaymentRequired("c/live", at)).resolves.toBeUndefined();
    expect((await readBalanceState()).payment).toEqual({ at: at.toISOString(), endpoint: "c/live" });
    expect(sent).toEqual([]);
    expect(await db.select().from(settings).where(inArray(settings.key, [balanceAlertKey(at.toISOString().slice(0, 10), "payment")]))).toEqual([]);

    mail.configured = true;
    mail.failing = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notePaymentRequired("c/live", minutes(at, 2))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    warn.mockRestore();
    mail.failing = false;
    await notePaymentRequired("c/live", minutes(at, 4));
    expect(sent).toHaveLength(1);
  });

  it("emails on the first 40203 of the day and records it, apart from the balance alerts", async () => {
    const at = newDay();
    await check(minutes(at, -60), 4.1);
    sent.length = 0;
    await noteDailyLimit("ai_optimization/gemini/llm_responses/live", at);
    await noteDailyLimit("serp/google/organic/task_post", minutes(at, 5));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe("SEOpen: DataForSEO's daily spend limit is reached, paid calls are failing until 00:00 UTC");
    expect(sent[0].text).toContain("ai_optimization/gemini/llm_responses/live");
    expect((await readBalanceState()).limit).toEqual({ at: minutes(at, 5).toISOString(), endpoint: "serp/google/organic/task_post" });
    // It doesn't cover the day's payment alert: a 402 still emails.
    await notePaymentRequired("rank/task_post", minutes(at, 10));
    expect(sent).toHaveLength(2);
  });
});
