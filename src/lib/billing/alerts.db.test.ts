import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { like, sql } from "drizzle-orm";
import { testDb } from "@/db/test-db";

/**
 * The owner's platform cap alert against seopen_test: 80% and 100% once each per cap per month,
 * however many days or checks see it, and again for a new month or a raised cap. The cap and the
 * spend are handed in, because the platform's real row and setting are shared by every test file.
 * The send is stubbed, so nothing reaches Resend.
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
vi.stubEnv("BETTER_AUTH_URL", "https://app.seopen.example");

const ready = await testDb();

const { db } = await import("@/db");
const { settings } = await import("@/db/schema");
const { MONTH } = await import("./usage");
const { monthName, platformAlertKey, platformAlertPercent, sendPlatformCapAlert } = await import("./alerts");

/** Caps no real setting uses, one per test, so their claims are this file's alone. Whole hundreds, so a share of one is exact. */
let nextCap = 50_000_000 + Math.floor(Math.random() * 100_000) * 1_000;
const caps: number[] = [];
function newCap() {
  nextCap += 100;
  caps.push(nextCap);
  return nextCap;
}
const pct = (cap: number, percent: number) => (cap / 100) * percent;

/** The checks a test runs: a fixed cap, and spend it can move. */
function platform(capUsd: number) {
  const usage = { spentUsd: 0, reservedUsd: 0 };
  const read = { cap: async () => capUsd, usage: async () => ({ ...usage }) };
  return { usage, check: () => sendPlatformCapAlert(read) };
}

const thisMonth = async () => (await db.execute<{ month: string }>(sql`select ${MONTH}::text as month`))[0].month;

describe("platformAlertPercent", () => {
  it("reads the highest share reached, and nothing without a cap", () => {
    expect(platformAlertPercent(79.99, 100)).toBeNull();
    expect(platformAlertPercent(80, 100)).toBe(80);
    expect(platformAlertPercent(99.99, 100)).toBe(80);
    expect(platformAlertPercent(100, 100)).toBe(100);
    expect(platformAlertPercent(140, 100)).toBe(100);
    expect(platformAlertPercent(500, null)).toBeNull();
    expect(platformAlertPercent(500, 0)).toBeNull();
  });

  it("names the month", () => {
    expect(monthName("2026-11-01")).toBe("November 2026");
  });
});

describe.skipIf(!ready)("platform cap alert", () => {
  beforeEach(() => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
  });

  afterAll(async () => {
    for (const cap of caps) await db.delete(settings).where(like(settings.key, `platform.cap_alert:%:${cap}`));
  });

  it("sends nothing below 80%", async () => {
    const p = platform(newCap());
    p.usage.spentUsd = pct(nextCap, 79);
    expect(await p.check()).toEqual({ percent: null, emailed: false });
    expect(sent).toHaveLength(0);
  });

  it("alerts at 80% once, not every day, then once at 100%", async () => {
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = pct(cap, 82);
    expect(await p.check()).toEqual({ percent: 80, emailed: true });
    // The next days' runs, still between 80% and 100%.
    for (let day = 0; day < 5; day++) expect(await p.check()).toEqual({ percent: 80, emailed: false });
    expect(sent).toHaveLength(1);
    const month = monthName(await thisMonth());
    expect(sent[0].to).toBe(ALERT_TO);
    expect(sent[0].subject).toBe(`SEOpen platform cap: 82% used for ${month}`);
    expect(sent[0].text).toContain(`for ${month} is $${pct(cap, 82).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
    expect(sent[0].text).toContain(`of the $${cap.toLocaleString("en-US")}.00 platform cap`);
    expect(sent[0].text).toContain("At 100%, every workspace's paid calls are refused until the 1st or until you raise the cap");
    expect(sent[0].text).toContain("Scheduled jobs pause.");
    expect(sent[0].text).toContain("https://app.seopen.example/admin/spend");

    p.usage.spentUsd = pct(cap, 99);
    p.usage.reservedUsd = pct(cap, 1);
    expect(await p.check()).toEqual({ percent: 100, emailed: true });
    for (let day = 0; day < 5; day++) await p.check();
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe(`SEOpen platform cap reached: paid calls stopped for ${month}`);
    expect(sent[1].text).toContain("held by calls in progress");
    expect(sent[1].text).toContain("Now every workspace's paid calls are refused");
  });

  it("sends only the 100% alert when spend jumps past both, and no 80% one after", async () => {
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = pct(cap, 105);
    expect(await p.check()).toEqual({ percent: 100, emailed: true });
    p.usage.spentUsd = pct(cap, 90); // a refund brings it back under
    expect(await p.check()).toEqual({ percent: 80, emailed: false });
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining("platform cap reached")]);
  });

  it("sends once when many checks see 100% at once", async () => {
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = cap;
    const results = await Promise.all(Array.from({ length: 25 }, () => p.check()));
    expect(results.filter((r) => r.emailed)).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it("sends again in a new month", async () => {
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = cap;
    await p.check();
    await p.check();
    expect(sent).toHaveLength(1);
    // The claims that were made become last month's.
    const month = await thisMonth();
    const last = (await db.execute<{ month: string }>(sql`select (${MONTH} - interval '1 month')::date::text as month`))[0].month;
    for (const percent of [80, 100] as const) {
      await db.update(settings).set({ key: platformAlertKey(last, percent, cap) }).where(sql`${settings.key} = ${platformAlertKey(month, percent, cap)}`);
    }
    expect(await p.check()).toEqual({ percent: 100, emailed: true });
    expect(sent).toHaveLength(2);
  });

  it("sends again once the owner raises the cap and spend reaches the new one", async () => {
    const cap = newCap();
    const before = platform(cap);
    before.usage.spentUsd = cap;
    await before.check();
    const raised = newCap() + 0.5; // a different cap, so a different claim
    caps.push(raised);
    const after = platform(raised);
    after.usage.spentUsd = cap;
    expect(await after.check()).toEqual({ percent: 80, emailed: true });
    after.usage.spentUsd = raised;
    expect(await after.check()).toEqual({ percent: 100, emailed: true });
    expect(sent).toHaveLength(3);
  });

  it("claims nothing without an email key, and sends once one is set", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = cap;
    mail.configured = false;
    expect(await p.check()).toEqual({ percent: 100, emailed: false });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("RESEND_API_KEY"));
    spy.mockRestore();
    mail.configured = true;
    expect(await p.check()).toEqual({ percent: 100, emailed: true });
    expect(sent).toHaveLength(1);
  });

  it("claims nothing without an address, and never falls back to SEOpen's own", async () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = cap;
    vi.stubEnv("OWNER_ALERT_EMAIL", "");
    vi.stubEnv("NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL", "");
    try {
      expect(await p.check()).toEqual({ percent: 100, emailed: false });
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("OWNER_ALERT_EMAIL isn't set here"));
      expect(sent).toHaveLength(0);
      vi.stubEnv("NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL", "seo@example.org");
      expect(await p.check()).toEqual({ percent: 100, emailed: true });
      expect(sent[0].to).toBe("seo@example.org");
    } finally {
      vi.stubEnv("OWNER_ALERT_EMAIL", ALERT_TO);
      vi.stubEnv("NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL", "");
      spy.mockRestore();
    }
  });

  it("gives the claim back when the send fails, so the next check sends", async () => {
    const cap = newCap();
    const p = platform(cap);
    p.usage.spentUsd = cap;
    mail.failing = true;
    await expect(p.check()).rejects.toThrow("Resend rejected");
    mail.failing = false;
    expect(await p.check()).toEqual({ percent: 100, emailed: true });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing when no cap is set", async () => {
    const read = { cap: async () => null, usage: async () => ({ spentUsd: 1_000_000, reservedUsd: 0 }) };
    expect(await sendPlatformCapAlert(read)).toEqual({ percent: null, emailed: false });
    expect(sent).toHaveLength(0);
  });
});
