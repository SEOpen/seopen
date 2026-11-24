import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";
import type { AccessReport } from "@/modules/audit/access";

/**
 * Alerts against seopen_test: rules fire where the data arrives, one thing alerts once while it
 * stays broken, a project gets at most one urgent and one daily email a day, a rule turned off
 * stays quiet, and a failed send is retried with the same key. The send is stubbed, so nothing
 * reaches Resend.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string; headers?: Record<string, string>; key?: string }[]);
const mail = vi.hoisted(() => ({ failing: false, configured: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  emailConfigured: () => mail.configured,
  sendEmail: async (msg: { to: string; subject: string; text: string; headers?: Record<string, string> }, opts: { idempotencyKey?: string } = {}) => {
    if (mail.failing) throw new Error("Resend rejected the message");
    sent.push({ ...msg, key: opts.idempotencyKey });
  },
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { alertsAfterCrawl } = await import("./after");
const { alertsFromRun } = await import("./record");
const { deliverAlerts, deliverDue } = await import("./deliver");
const { setAlertRuleOp } = await import("./ops");

/** Monday 16 November 2026, 09:00 in New York: before the day's email. */
const MORNING = new Date("2026-11-16T14:00:00Z");
/** 13:00 in New York the same day: after it. */
const AFTERNOON = new Date("2026-11-16T18:00:00Z");
const NEXT_DAY = new Date("2026-11-17T18:00:00Z");

const made: string[] = [];
/** Every project made here. deliverDue reads the whole database, so the alerts left unsent on purpose are closed at the end. */
const projectsMade: number[] = [];

async function setup(o: { plan?: string; recap?: boolean; alertEmails?: boolean } = {}) {
  const email = `alerts-${randomUUID().slice(0, 8)}@example.com`;
  const [user] = await db.insert(s.users).values({ id: randomUUID(), email, emailVerified: true, weeklyRecap: o.recap ?? true, alertEmails: o.alertEmails ?? true }).returning();
  made.push(user.id);
  const [ws] = await db.insert(s.workspaces).values({ name: email, plan: o.plan ?? "internal" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: `Site ${ws.id}`, domain: `alerts-${ws.id}.example` }).returning();
  projectsMade.push(project.id);
  const scope = { workspaceId: ws.id, projectId: project.id };
  const url = (path: string) => `https://${project.domain}${path}`;
  return { userId: user.id, email, scope, project, url };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function crawl(p: Setup, o: { summary?: unknown } = {}) {
  const [row] = await db
    .insert(s.auditCrawls)
    .values({ ...p.scope, target: p.project.domain, maxPages: 10, status: "done", finishedAt: new Date(), summary: o.summary ?? null })
    .returning();
  return row;
}

async function clicks(p: Setup, path: string, n: number, date = "2026-11-12") {
  await db.insert(s.gscPages).values({ ...p.scope, date, page: p.url(path), clicks: n, impressions: n * 10, ctr: 0.1, position: 4 });
}

const access = (p: Setup, keyPages: string[]): AccessReport => ({ checkedAt: "", robots: { url: p.url("/robots.txt"), status: 200, fetchedAt: "", found: true, error: null, sitemaps: [] }, crawlers: [], keyPages: keyPages.map(p.url), probes: [], rendered: null, http: null, sitemap: null });

async function crawlWith(p: Setup, pages: { path: string; status: number }[], at: Date, extra: { noindex?: string[]; blocked?: string[]; keyPages?: string[] } = {}) {
  const c = await crawl(p);
  const report = extra.keyPages ? access(p, extra.keyPages) : null;
  await alertsAfterCrawl(
    {
      crawl: { ...p.scope, id: c.id },
      pages: pages.map((x) => ({ url: p.url(x.path), statusCode: x.status })),
      nonIndexable: (extra.noindex ?? []).map((path) => ({ url: p.url(path), reason: "meta_tag" })),
      issues: (extra.blocked ?? []).map((path) => ({ code: "search-bot-blocked", url: p.url(path), detail: "Googlebot (Disallow: /)" })),
      report,
    },
    at,
  );
  if (report) await db.update(s.auditCrawls).set({ summary: { access: report } }).where(eq(s.auditCrawls.id, c.id));
  if (extra.blocked?.length) await db.insert(s.auditIssues).values(extra.blocked.map((path) => ({ workspaceId: p.scope.workspaceId, crawlId: c.id, code: "search-bot-blocked", url: p.url(path), detail: "Googlebot (Disallow: /)" })));
  return c;
}

const open = (p: Setup) =>
  db
    .select()
    .from(s.alerts)
    .where(and(eq(s.alerts.projectId, p.scope.projectId)))
    .orderBy(s.alerts.id);

const sentTo = (email: string) => sent.filter((m) => m.to === email);

afterAll(async () => {
  if (!ready || !projectsMade.length) return;
  await db.update(s.alerts).set({ resolvedAt: new Date() }).where(and(inArray(s.alerts.projectId, projectsMade), isNull(s.alerts.resolvedAt)));
});

describe.skipIf(!ready)("alerts", () => {
  beforeEach(() => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
    vi.stubEnv("SEOPEN_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    if (made.length) await db.update(s.users).set({ weeklyRecap: false }).where(inArray(s.users.id, made.splice(0)));
  });

  it("emails a clicked page that breaks at once, with its source, time and link, and doesn't alert again while it stays broken", async () => {
    const p = await setup();
    await clicks(p, "/pricing", 40);
    await clicks(p, "/blog", 2);
    await crawlWith(p, [{ path: "/pricing", status: 404 }, { path: "/blog", status: 200 }, { path: "/quiet", status: 500 }], MORNING);
    const [alert, ...rest] = await open(p);
    expect(rest).toEqual([]);
    expect(alert).toMatchObject({ rule: "page-broken", title: "/pricing answers 404", source: "Site audit crawl", resolvedAt: null });
    const [mailed, ...more] = sentTo(p.email);
    expect(more).toEqual([]);
    expect(mailed.subject).toBe(`Urgent: /pricing answers 404 (Site ${p.scope.workspaceId})`);
    expect(mailed.text).toContain("40 Search Console clicks in the last 28 days");
    expect(mailed.text).toContain("Site audit crawl, found Nov 16, 9:00 AM ET");
    expect(mailed.text).toContain(`/projects/${p.scope.projectId}/alerts/${alert.id}`);
    expect(mailed.headers?.["List-Unsubscribe"]).toContain("list=alerts");
    expect(mailed.key).toMatch(new RegExp(`^alerts/\\d+/${p.userId}$`));

    // The next crawl still sees it broken: no new alert, no email.
    await crawlWith(p, [{ path: "/pricing", status: 404 }], AFTERNOON);
    expect(await open(p)).toHaveLength(1);
    await deliverDue(AFTERNOON);
    expect(sentTo(p.email)).toHaveLength(1);
  });

  it("closes an alert once a crawl finds the page working, and opens a new one if it breaks again", async () => {
    const p = await setup();
    await clicks(p, "/pricing", 40);
    await crawlWith(p, [{ path: "/pricing", status: 404 }], MORNING);
    await crawlWith(p, [{ path: "/pricing", status: 200 }], AFTERNOON);
    expect((await open(p)).map((a) => a.resolvedAt != null)).toEqual([true]);
    await crawlWith(p, [{ path: "/pricing", status: 200 }], AFTERNOON, { noindex: ["/pricing"] });
    expect((await open(p)).map((a) => [a.title, a.resolvedAt != null])).toEqual([
      ["/pricing answers 404", true],
      ["/pricing is set to noindex", false],
    ]);
  });

  it("sends at most one urgent email a day, and the day's email carries what came after", async () => {
    const p = await setup();
    await clicks(p, "/pricing", 40);
    await clicks(p, "/contact", 9);
    await crawlWith(p, [{ path: "/pricing", status: 404 }], MORNING);
    expect(sentTo(p.email)).toHaveLength(1);
    await crawlWith(p, [{ path: "/pricing", status: 404 }, { path: "/contact", status: 410 }], new Date(MORNING.getTime() + 3_600_000));
    // The urgent email already went today, and it isn't time for the day's email yet.
    expect(sentTo(p.email)).toHaveLength(1);
    await deliverDue(new Date(MORNING.getTime() + 2 * 3_600_000));
    expect(sentTo(p.email)).toHaveLength(1);
    await deliverDue(AFTERNOON);
    const later = sentTo(p.email);
    expect(later).toHaveLength(2);
    expect(later[1].subject).toBe(`Urgent: /contact answers 410 (Site ${p.scope.workspaceId})`);
    expect(later[1].text).not.toContain("/pricing");
    // Run again: nothing left to send.
    await deliverDue(AFTERNOON);
    expect(sentTo(p.email)).toHaveLength(2);
  });

  it("batches a keyword out of the top 10 into the day's email, from a confirmed earlier position only", async () => {
    const p = await setup();
    const [kw, kw2, kw3] = await db
      .insert(s.rankKeywords)
      .values([{ ...p.scope, keyword: "emergency plumber" }, { ...p.scope, keyword: "drain repair" }, { ...p.scope, keyword: "boiler service" }])
      .returning();
    const [before, run] = await db
      .insert(s.rankRuns)
      .values([
        { ...p.scope, kind: "daily", date: "2026-11-15", depth: 20, status: "done" },
        { ...p.scope, kind: "daily", date: "2026-11-16", depth: 20, status: "done" },
      ])
      .returning();
    const result = (keywordId: number, runId: number, date: string, position: number | null, notChecked = false) => ({ ...p.scope, keywordId, runId, date, depth: 20, position, checkedAt: new Date(), notChecked, locationCode: 2840 });
    await db.insert(s.rankResults).values([
      result(kw.id, before.id, "2026-11-15", 6),
      result(kw.id, run.id, "2026-11-16", null),
      // Only an unconfirmed position before: not a fall.
      result(kw2.id, before.id, "2026-11-15", 3, true),
      result(kw2.id, run.id, "2026-11-16", 15),
      // Unconfirmed now: not a fall either.
      result(kw3.id, before.id, "2026-11-15", 2),
      result(kw3.id, run.id, "2026-11-16", 30, true),
    ]);
    expect(await alertsFromRun(run.id, MORNING)).toBe(1);
    expect(await alertsFromRun(run.id, MORNING)).toBe(0);
    const [alert] = await open(p);
    expect(alert).toMatchObject({ rule: "left-top-10", title: "“emergency plumber” left the top 10", detail: "Position 6 on Nov 15, not in the top 20 now.", source: "Rank check", screen: `/rank/${kw.id}` });
    // Not urgent: nothing until the day's email.
    expect(await deliverAlerts(p.scope, "urgent", MORNING)).toBe("nothing");
    await deliverDue(MORNING);
    expect(sentTo(p.email)).toEqual([]);
    await deliverDue(AFTERNOON);
    expect(sentTo(p.email).map((m) => m.subject)).toEqual([`“emergency plumber” left the top 10 (Site ${p.scope.workspaceId})`]);
    // One daily email a day: a second fall waits for tomorrow.
    await db.insert(s.rankResults).values([result(kw3.id, before.id, "2026-11-14", 4)]);
    await db.update(s.rankResults).set({ notChecked: false }).where(and(eq(s.rankResults.keywordId, kw3.id), eq(s.rankResults.runId, run.id)));
    await db.delete(s.rankResults).where(and(eq(s.rankResults.keywordId, kw3.id), eq(s.rankResults.date, "2026-11-15")));
    expect(await alertsFromRun(run.id, AFTERNOON)).toBe(1);
    expect(await deliverAlerts(p.scope, "daily", AFTERNOON)).toBe("limit");
    await deliverDue(NEXT_DAY);
    expect(sentTo(p.email)).toHaveLength(2);
    expect(sentTo(p.email)[1].subject).toContain("boiler service");
  });

  it("finds a search bot newly blocked against the previous crawl's check", async () => {
    const p = await setup();
    await crawlWith(p, [], MORNING, { keyPages: ["/", "/blog"] });
    expect(await open(p)).toEqual([]);
    await crawlWith(p, [], MORNING, { keyPages: ["/", "/blog"], blocked: ["/blog"] });
    const [alert] = await open(p);
    expect(alert).toMatchObject({ rule: "bot-blocked", title: "robots.txt now blocks search crawlers from /blog" });
    expect(sentTo(p.email)).toHaveLength(1);
    // Still blocked on the next crawl: it was blocked before, so nothing new.
    await crawlWith(p, [], AFTERNOON, { keyPages: ["/", "/blog"], blocked: ["/blog"] });
    expect(await open(p)).toHaveLength(1);
  });

  it("records nothing for a rule the project turned off, which the op previews first", async () => {
    const p = await setup();
    const actor = { userId: p.userId, source: "app" as const };
    const preview = await setAlertRuleOp(p.scope, actor, { rule: "page-broken", enabled: false }, { dryRun: true });
    expect(preview).toMatchObject({ rule: "page-broken", enabled: false, changed: true });
    await setAlertRuleOp(p.scope, actor, { rule: "page-broken", enabled: false });
    expect(await setAlertRuleOp(p.scope, actor, { rule: "page-broken", enabled: false }, { dryRun: true })).toMatchObject({ changed: false });
    await clicks(p, "/pricing", 40);
    await crawlWith(p, [{ path: "/pricing", status: 404 }], MORNING);
    expect(await open(p)).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("goes only to people who get the recap and kept alert emails on, on a plan that has the recap", async () => {
    const off = await setup({ alertEmails: false });
    const noRecap = await setup({ recap: false });
    const free = await setup({ plan: "free" });
    for (const p of [off, noRecap, free]) {
      await clicks(p, "/pricing", 40);
      await crawlWith(p, [{ path: "/pricing", status: 404 }], MORNING);
      expect(await open(p)).toHaveLength(1);
    }
    expect(sent).toEqual([]);
    // Nobody to send to uses up no claim.
    expect(await db.select().from(s.alertSends).where(inArray(s.alertSends.projectId, [off, noRecap, free].map((p) => p.scope.projectId)))).toEqual([]);
  });

  it("retries a failed send with the same alerts and key, and doesn't claim anything without an email key", async () => {
    const p = await setup();
    await clicks(p, "/pricing", 40);
    mail.configured = false;
    await crawlWith(p, [{ path: "/pricing", status: 404 }], MORNING);
    expect(await db.select().from(s.alertSends).where(eq(s.alertSends.projectId, p.scope.projectId))).toEqual([]);
    mail.configured = true;
    mail.failing = true;
    expect(await deliverAlerts(p.scope, "urgent", MORNING)).toBe("failed");
    const [claim] = await db.select().from(s.alertSends).where(eq(s.alertSends.projectId, p.scope.projectId));
    expect(claim.sentAt).toBeNull();
    await expect(deliverDue(MORNING)).rejects.toThrow(/not sent/);
    mail.failing = false;
    await deliverDue(MORNING);
    expect(sentTo(p.email).map((m) => m.key)).toEqual([`alerts/${claim.id}/${p.userId}`]);
    const [after] = await db.select().from(s.alertSends).where(eq(s.alertSends.id, claim.id));
    expect(after.sentAt).not.toBeNull();
  });
});
