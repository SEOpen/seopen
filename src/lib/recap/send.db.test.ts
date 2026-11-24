import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The weekly recap against seopen_test: who gets one (opted in, verified, a plan that has it, the
 * rollout gate), who doesn't (opted out, Free, nothing to say), and that a run again, or a retry
 * after a failed send, never sends twice. The send is stubbed, so nothing reaches Resend.
 */

const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string; headers?: Record<string, string>; key?: string }[]);
const mail = vi.hoisted(() => ({ failing: false, configured: true }));
/** The rollout gate, widened for the tests of the plans behind it. */
const gate = vi.hoisted(() => ({ widened: false }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  emailConfigured: () => mail.configured,
  sendEmail: async (msg: { to: string; subject: string; text: string; headers?: Record<string, string> }, opts: { idempotencyKey?: string } = {}) => {
    if (mail.failing) throw new Error("Resend rejected the message");
    sent.push({ ...msg, key: opts.idempotencyKey });
  },
}));
vi.mock("./gate", async (orig) => {
  const real = await orig<typeof import("./gate")>();
  return { ...real, recapOpen: (ws: { plan: string }) => real.onRecapPlan(ws) && (gate.widened || real.recapRolledOut(ws)) };
});

const ready = await testDb();

const { db } = await import("@/db");
const { alerts, auditCrawls, gscDaily, gscQueryPages, projects, recapSends, users, workspaceMembers, workspaces } = await import("@/db/schema");
const { recapKey, recapWeek, sendWeeklyRecaps } = await import("./send");
const { unsubscribeUrl } = await import("./unsubscribe");
const unsubscribe = await import("@/app/api/email/unsubscribe/route");

/** Monday 2 November 2026, 15:00 UTC: 10:00 in New York, when the job runs. */
const NOW = new Date("2026-11-02T15:00:00Z");
const DAY = 86_400_000;

const made: string[] = [];
/** Every project made here: the hourly alert pass reads the whole database, so their alerts are closed at the end. */
const projectsMade: number[] = [];

/** A verified person in their own workspace with one project. `moved`: two crawls this week, the health score up 25. */
async function person(o: { plan?: string; optedIn?: boolean; verified?: boolean; moved?: boolean } = {}) {
  const email = `recap-${randomUUID().slice(0, 8)}@example.com`;
  const [user] = await db.insert(users).values({ id: randomUUID(), email, emailVerified: o.verified ?? true, weeklyRecap: o.optedIn ?? true }).returning();
  made.push(user.id);
  const [ws] = await db.insert(workspaces).values({ name: email, plan: o.plan ?? "internal" }).returning();
  await db.insert(workspaceMembers).values({ workspaceId: ws.id, userId: user.id, role: "owner" });
  const [project] = await db.insert(projects).values({ workspaceId: ws.id, name: `Site ${ws.id}`, domain: `recap-${ws.id}.example` }).returning();
  projectsMade.push(project.id);
  if (o.moved ?? true) {
    const crawl = (score: number, daysAgo: number) => ({
      workspaceId: ws.id,
      projectId: project.id,
      target: project.domain,
      maxPages: 10,
      status: "done",
      pagesCrawled: 3,
      healthScore: score,
      createdAt: new Date(NOW.getTime() - daysAgo * DAY),
      finishedAt: new Date(NOW.getTime() - daysAgo * DAY),
    });
    await db.insert(auditCrawls).values([crawl(60, 6), crawl(85, 1)]);
  }
  return { userId: user.id, email, workspaceId: ws.id, projectId: project.id };
}

const sentTo = (email: string) => sent.filter((m) => m.to === email);

const optOut = async () => {
  if (made.length) await db.update(users).set({ weeklyRecap: false }).where(inArray(users.id, made.splice(0)));
};

afterAll(async () => {
  if (!ready || !projectsMade.length) return;
  await db.update(alerts).set({ resolvedAt: new Date() }).where(and(inArray(alerts.projectId, projectsMade), isNull(alerts.resolvedAt)));
});

describe.skipIf(!ready)("weekly recap", () => {
  beforeEach(() => {
    sent.length = 0;
    mail.failing = false;
    mail.configured = true;
    gate.widened = false;
    vi.stubEnv("BETTER_AUTH_URL", "https://app.seopen.example");
    vi.stubEnv("SEOPEN_SECRET_KEY", Buffer.alloc(32, 7).toString("base64"));
  });
  // Opted-in people from one test would get the next test's run too.
  afterEach(async () => {
    vi.unstubAllEnvs();
    await optOut();
  });

  it("goes to someone who turned it on, with what moved, a link to the project and one-click unsubscribe", async () => {
    const p = await person();
    const run = await sendWeeklyRecaps(NOW);
    expect(run.week).toBe("2026-11-02");
    const [mailed] = sentTo(p.email);
    expect(sentTo(p.email)).toHaveLength(1);
    expect(mailed.subject).toBe(`Your week in SEOpen: Site ${p.workspaceId}`);
    expect(mailed.text).toContain("Health score up 25, from 60 to 85 (vs previous crawl)");
    expect(mailed.text).toContain(`/projects/${p.projectId}`);
    expect(mailed.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/.+\/api\/email\/unsubscribe\?t=.+>$/);
    expect(mailed.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(mailed.key).toBe(recapKey(p.workspaceId, p.userId, "2026-11-02"));
  });

  it("lists the pages closest to page one from Search Console, with the days they cover", async () => {
    const p = await person();
    await db.update(projects).set({ gscProperty: `sc-domain:recap-${p.workspaceId}.example` }).where(eq(projects.id, p.projectId));
    const scope = { workspaceId: p.workspaceId, projectId: p.projectId };
    const url = (path: string) => `https://recap-${p.workspaceId}.example${path}`;
    const pair = (query: string, path: string, impressions: number, position: number) => ({ ...scope, date: "2026-10-20", query, page: url(path), clicks: 1, impressions, ctr: 1 / impressions, position });
    await db.insert(gscDaily).values([{ ...scope, date: "2026-10-03", clicks: 1, impressions: 10, ctr: 0.1, position: 9 }, { ...scope, date: "2026-10-30", clicks: 1, impressions: 10, ctr: 0.1, position: 9 }]);
    await db.insert(gscQueryPages).values([pair("emergency plumber", "/emergency", 400, 6), pair("drain repair", "/drains", 300, 12), pair("boiler service", "/boilers", 200, 9), pair("water heater", "/heaters", 100, 18), pair("plumber", "/", 900, 2)]);
    await sendWeeklyRecaps(NOW);
    const [mailed] = sentTo(p.email);
    expect(mailed.text).toContain(["3 pages closest to page one:", "- /emergency: “emergency plumber” at position 6, 400 impressions (Search Console, Oct 3 to Oct 30, 2026)", "- /drains: “drain repair” at position 12, 300 impressions (Search Console, Oct 3 to Oct 30, 2026)", "- /boilers: “boiler service” at position 9, 200 impressions (Search Console, Oct 3 to Oct 30, 2026)"].join("\n"));
    expect(mailed.text).not.toContain("/heaters");
  });

  it("isn't sent to someone who didn't turn it on, or whose email isn't verified", async () => {
    const off = await person({ optedIn: false });
    const unverified = await person({ verified: false });
    await sendWeeklyRecaps(NOW);
    expect(sentTo(off.email)).toHaveLength(0);
    expect(sentTo(unverified.email)).toHaveLength(0);
  });

  it("goes only to the owner's workspace while the rollout gate is closed", async () => {
    const starter = await person({ plan: "starter" });
    await sendWeeklyRecaps(NOW);
    expect(sentTo(starter.email)).toHaveLength(0);
  });

  it("skips Free once the gate opens, and sends to Starter, Pro and trial", async () => {
    gate.widened = true;
    const free = await person({ plan: "free" });
    const paid = await Promise.all(["starter", "pro", "trial"].map((plan) => person({ plan })));
    await sendWeeklyRecaps(NOW);
    expect(sentTo(free.email)).toHaveLength(0);
    for (const p of paid) expect(sentTo(p.email)).toHaveLength(1);
  });

  it("lists the week's alerts, which make a section alone", async () => {
    const p = await person({ moved: false });
    const scope = { workspaceId: p.workspaceId, projectId: p.projectId };
    const alert = { ...scope, rule: "page-broken", title: "/pricing answers 404", source: "Site audit crawl", screen: "/audit/pages" };
    await db.insert(alerts).values([
      { ...alert, key: "a", detectedAt: new Date(NOW.getTime() - 2 * DAY) },
      // Older than a week: an earlier recap's news.
      { ...alert, key: "b", title: "/old answers 500", detectedAt: new Date(NOW.getTime() - 9 * DAY) },
    ]);
    await sendWeeklyRecaps(NOW);
    const [mailed] = sentTo(p.email);
    expect(mailed.text).toContain("1 alert this week:\n- /pricing answers 404 (Site audit crawl, Oct 31)");
    expect(mailed.text).not.toContain("/old");
  });

  it("sends nothing when no project has anything to say", async () => {
    const quiet = await person({ moved: false });
    const run = await sendWeeklyRecaps(NOW);
    expect(sentTo(quiet.email)).toHaveLength(0);
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    expect(await db.select().from(recapSends).where(eq(recapSends.userId, quiet.userId))).toHaveLength(0);
  });

  it("never sends twice in a week, and does again the next week", async () => {
    const p = await person();
    await sendWeeklyRecaps(NOW);
    await sendWeeklyRecaps(new Date(NOW.getTime() + 3_600_000));
    await Promise.all([sendWeeklyRecaps(NOW), sendWeeklyRecaps(NOW)]);
    expect(sentTo(p.email)).toHaveLength(1);
    expect(recapWeek(new Date(NOW.getTime() + 2 * DAY))).toBe("2026-11-02");
    // The next Monday the crawls are over a week old, so a new one finishes the day before.
    const next = new Date(NOW.getTime() + 7 * DAY);
    await db.insert(auditCrawls).values({ workspaceId: p.workspaceId, projectId: p.projectId, target: "x", maxPages: 10, status: "done", healthScore: 70, createdAt: new Date(next.getTime() - DAY), finishedAt: new Date(next.getTime() - DAY) });
    await sendWeeklyRecaps(next);
    expect(sentTo(p.email)).toHaveLength(2);
    expect(sentTo(p.email)[1].key).toBe(recapKey(p.workspaceId, p.userId, "2026-11-09"));
  });

  it("gives a failed send's claim back, so the job's retry sends it once", async () => {
    const p = await person();
    mail.failing = true;
    await expect(sendWeeklyRecaps(NOW)).rejects.toThrow(/not sent/);
    expect(await db.select().from(recapSends).where(and(eq(recapSends.userId, p.userId), eq(recapSends.week, "2026-11-02")))).toHaveLength(0);
    mail.failing = false;
    await sendWeeklyRecaps(NOW);
    await sendWeeklyRecaps(NOW);
    expect(sentTo(p.email)).toHaveLength(1);
  });

  it("sends nothing and claims nothing where email isn't set up", async () => {
    const p = await person();
    mail.configured = false;
    await sendWeeklyRecaps(NOW);
    expect(sentTo(p.email)).toHaveLength(0);
    expect(await db.select().from(recapSends).where(eq(recapSends.userId, p.userId))).toHaveLength(0);
  });
});

describe.skipIf(!ready)("the unsubscribe link", () => {
  beforeEach(() => vi.stubEnv("SEOPEN_SECRET_KEY", Buffer.alloc(32, 7).toString("base64")));
  afterEach(async () => {
    vi.unstubAllEnvs();
    await optOut();
  });

  const optedIn = async (id: string) => (await db.select({ on: users.weeklyRecap }).from(users).where(eq(users.id, id)))[0]?.on;

  it("asks first on a GET, and turns the recap off on the one-click POST", async () => {
    const p = await person();
    const url = unsubscribeUrl("https://app.example.test", p.userId);
    const asked = await unsubscribe.GET(new Request(url));
    expect(asked.status).toBe(200);
    expect(await asked.text()).toContain('<form method="post">');
    expect(await optedIn(p.userId)).toBe(true);
    const done = await unsubscribe.POST(new Request(url, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } }));
    expect(done.status).toBe(200);
    expect(await optedIn(p.userId)).toBe(false);
  });

  it("turns off alert emails only, from an alerts link", async () => {
    const p = await person();
    const url = unsubscribeUrl("https://app.example.test", p.userId, "alerts");
    expect(await (await unsubscribe.GET(new Request(url))).text()).toContain("Stop alert emails?");
    await unsubscribe.POST(new Request(url, { method: "POST" }));
    const [row] = await db.select({ recap: users.weeklyRecap, alerts: users.alertEmails }).from(users).where(eq(users.id, p.userId));
    expect(row).toEqual({ recap: true, alerts: false });
    // A recap link can't be passed off as an alerts one.
    const recapLink = new URL(unsubscribeUrl("https://app.example.test", p.userId));
    recapLink.searchParams.set("list", "alerts");
    expect((await unsubscribe.POST(new Request(recapLink, { method: "POST" }))).status).toBe(400);
  });

  it("refuses a link that wasn't signed for that person", async () => {
    const p = await person();
    const other = new URL(unsubscribeUrl("https://app.example.test", p.userId));
    other.searchParams.set("t", `${Buffer.from(p.userId).toString("base64url")}.forged`);
    expect((await unsubscribe.POST(new Request(other, { method: "POST" }))).status).toBe(400);
    expect((await unsubscribe.GET(new Request(other))).status).toBe(400);
    expect(await optedIn(p.userId)).toBe(true);
    await db.update(users).set({ weeklyRecap: false }).where(eq(users.id, p.userId));
  });
});
