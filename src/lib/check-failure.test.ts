import { describe, expect, it, vi } from "vitest";
import { FREE_PLAN_REFUSAL, PLATFORM_REFUSAL } from "./billing/spend";
import { checkIsMainAction, DATA_STOPPED_DAYS, dataStopped, failedCheck, failureAgain, failureAside, failureLine, failureLink, failureTone, failureWords, isStalePosting, lastTry, needsLookClause, needsLookSentence, newerFailed, newestFailed, noResultsBecause, pageFailure, POSTING_NEVER_FINISHED, refusalFix, staleCaption, STALE_POSTING_MS, stoppedData, summaryFailure, withoutRetryAdvice, withoutTone, type CheckFailure } from "./check-failure";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));

const NOW = new Date("2026-11-07T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const failed = (noun: CheckFailure["noun"] = "check"): CheckFailure => failedCheck({ noun, at: new Date("2026-11-07T10:00:00Z"), timeZone: "UTC", reason: "Why.", retry: true, next: { label: "View", href: "/rank" } });
const reconnect: CheckFailure = { kind: "reconnect", noun: "sync", at: null, day: null, reason: "Why.", retry: false, next: { label: "Reconnect", href: "/gsc" }, provider: "Google" };

describe("newestFailed", () => {
  it("reads a failed newest row, timed when it finished", () => {
    const finishedAt = ago(1000);
    expect(newestFailed({ status: "failed", error: "No result after 3 days", createdAt: ago(5000), finishedAt })).toMatchObject({ at: finishedAt, stored: "No result after 3 days", stuck: false });
  });

  it("says nothing of a newest row that succeeded, is running, or doesn't exist", () => {
    for (const status of ["done", "pending", "posting", "queued", "running", "crawling"]) expect(newestFailed({ status, error: null, createdAt: ago(1000) })).toBeNull();
    expect(newestFailed(undefined)).toBeNull();
  });

  it("only calls a posting row failed past the existing rule, and only where that rule exists", () => {
    const young = { status: "posting", error: null, createdAt: ago(STALE_POSTING_MS - 1000) };
    const old = { status: "posting", error: null, createdAt: ago(STALE_POSTING_MS + 1000) };
    expect(isStalePosting(young, NOW)).toBe(false);
    expect(isStalePosting(old, NOW)).toBe(true);
    expect(newestFailed(young, { stalePosting: true, now: NOW })).toBeNull();
    expect(newestFailed(old, { stalePosting: true, now: NOW })?.stored).toBe("Posting never finished");
    expect(newestFailed(old, { now: NOW })).toBeNull();
  });

  it("never treats an old queued row as failed: it stays a check in flight", () => {
    expect(newestFailed({ status: "queued", error: null, createdAt: ago(30 * 24 * 3_600_000) }, { stalePosting: true, now: NOW })).toBeNull();
  });
});

describe("the words", () => {
  it("say when in the workspace's zone", () => {
    const late = failedCheck({ noun: "check", at: new Date("2026-11-08T02:00:00Z"), timeZone: "America/New_York", reason: "Why.", retry: true, next: { label: "View", href: "/rank" } });
    expect(late.day).toBe("Nov 7");
  });

  it("say a failed check, a failed crawl and a reconnect differently", () => {
    expect(failureWords(failed())).toBe("Last check failed Nov 7");
    expect(failureWords(failed("crawl"))).toBe("Last crawl failed Nov 7");
    expect(failureWords(reconnect)).toBe("Reconnect Google");
    expect(failureAside(failed("run"))).toBe("last run failed Nov 7");
    expect(failureAside(reconnect)).toBe("reconnect Google to update");
    expect(newerFailed(failed())).toBe("a newer check failed Nov 7");
    expect(newerFailed(reconnect)).toBe("reconnect Google to update");
  });

  it("label an older number with its date, without repeating a date its caption already gives", () => {
    expect(staleCaption("vs Nov 3", failed(), "Nov 5")).toBe("vs Nov 3. From Nov 5, last check failed Nov 7.");
    expect(staleCaption("keywords, checked Nov 5", failed(), "Nov 5")).toBe("keywords, checked Nov 5. Last check failed Nov 7.");
    expect(staleCaption("28 days to Oct 30", reconnect)).toBe("28 days to Oct 30. Reconnect Google to update.");
    expect(staleCaption(undefined, failed())).toBe("Last check failed Nov 7.");
  });

  it("say which source in one line, however many there are", () => {
    const rank = { label: "Rankings", failure: failed() };
    const audit = { label: "Site audit", failure: failed("crawl") };
    const gsc = { label: "Search Console", failure: reconnect };
    const ga4 = { label: "Analytics", failure: reconnect };
    expect(needsLookSentence([rank])).toBe("Rankings need a look: the last check failed on Nov 7.");
    expect(needsLookSentence([audit])).toBe("Site audit needs a look: the last crawl failed on Nov 7.");
    expect(needsLookSentence([rank, audit])).toBe("Rankings and Site audit need a look: their latest checks failed.");
    expect(needsLookSentence([gsc, ga4])).toBe("Reconnect Google to update Search Console and Analytics.");
    expect(needsLookSentence([rank, gsc])).toBe("Rankings need a look: the last check failed on Nov 7. Reconnect Google to update Search Console.");
    expect(needsLookClause([rank])).toBe("the last Rankings check failed on Nov 7");
    expect(needsLookClause([rank, audit])).toBe("the latest checks failed for Rankings and Site audit");
    expect(needsLookClause([rank, gsc])).toBe("the last Rankings check failed on Nov 7, and Google needs reconnecting");
  });
});

describe("checkIsMainAction", () => {
  it("is the main action before any results, however they got there", () => {
    expect(checkIsMainAction(false, null)).toBe(true);
    expect(checkIsMainAction(false, { retry: true })).toBe(true);
  });

  it("stands back once there are results, or when running another can't fix the failure", () => {
    expect(checkIsMainAction(true, null)).toBe(false);
    expect(checkIsMainAction(false, { retry: false })).toBe(false);
  });
});

describe("a check that didn't start", () => {
  const stuck = failedCheck({ noun: "check", at: NOW, timeZone: "UTC", reason: "This check didn't start.", retry: true, next: { label: "View", href: "/rank" }, stuck: true });

  it("comes from a row stuck posting, or one the next check closed for that", () => {
    expect(newestFailed({ status: "posting", error: null, createdAt: ago(STALE_POSTING_MS + 1000) }, { stalePosting: true, now: NOW })?.stuck).toBe(true);
    expect(newestFailed({ status: "failed", error: POSTING_NEVER_FINISHED, createdAt: ago(5000) })?.stuck).toBe(true);
  });

  it("is never said as a failure, or in red", () => {
    expect(lastTry(stuck)).toBe("Last check didn't start");
    expect(failureWords(stuck)).toBe("Last check didn't start Nov 7");
    expect(failureAside(stuck)).toBe("last check didn't start Nov 7");
    expect(newerFailed(stuck)).toBe("a newer check didn't start Nov 7");
    expect(noResultsBecause(stuck)).toBe("No results yet, because the last check didn't start.");
    expect(needsLookSentence([{ label: "Rankings", failure: stuck }])).toBe("Rankings need a look: the last check didn't start on Nov 7.");
    expect(needsLookClause([{ label: "Rankings", failure: stuck }])).toBe("the last Rankings check didn't start on Nov 7");
    expect(failureTone(stuck)).toBeUndefined();
    expect(failureTone(failed())).toBe("bad");
  });

  it("says its first words once in a row", () => {
    expect(failureLine(stuck)).toBe("Last check didn't start Nov 7.");
    expect(failureLine(failed())).toBe("Last check failed Nov 7. Why.");
  });

  it.skipIf(!rules.hasPlans)("gives the refusal and the way forward when the workspace can't spend, and offers the button otherwise", () => {
    const noted = pageFailure(stuck, FREE_PLAN_REFUSAL)!;
    expect(noted).toMatchObject({ retry: false, stuck: true, blocked: FREE_PLAN_REFUSAL.message, next: { label: "Open Billing", href: "/billing" } });
    expect(failureAgain(noted, "Check now runs it again.")).toBe(FREE_PLAN_REFUSAL.message);
    expect(failureLink(noted)).toEqual({ label: "Open Billing", href: "/billing" });
    expect(failureLine(noted)).toBe(`Last check didn't start Nov 7. ${FREE_PLAN_REFUSAL.message}`);
    expect(failureAgain(pageFailure(stuck, null)!, "Check now runs it again.")).toBe("Check now runs it again.");
  });

  it("mixes with real failures without calling them all one thing", () => {
    expect(needsLookSentence([{ label: "Rankings", failure: stuck }, { label: "Local SEO", failure: stuck }])).toContain("their latest checks didn't start");
    expect(needsLookSentence([{ label: "Rankings", failure: stuck }, { label: "Local SEO", failure: failed() }])).toContain("their latest checks didn't finish");
  });
});

describe("the plan and the button", () => {
  const retryable = failedCheck({ noun: "check", at: NOW, timeZone: "UTC", reason: "None came back. Run it again.", retry: true, next: { label: "View", href: "/rank" } });

  it("raises no alarm on the summaries for what the plan rules out, or a read-only project", () => {
    expect(summaryFailure(retryable, FREE_PLAN_REFUSAL)).toBeNull();
    expect(summaryFailure(retryable, { code: "locked", message: "read-only" })).toBeNull();
    expect(summaryFailure(retryable, { code: "no_plan", message: "no plan" })).toBeNull();
  });

  it.skipIf(!rules.hasPlans)("keeps a failure that a suspended or spent workspace can still clear, without the offer", () => {
    const f = summaryFailure(retryable, { code: "credits", message: "You've used this month's research credits." })!;
    expect(f).toMatchObject({ retry: false, reason: "None came back.", blocked: "You've used this month's research credits.", next: { href: "/billing" } });
    expect(failureAgain(f, "Check now runs it again.")).not.toMatch(/again/);
  });

  it("changes nothing with no refusal", () => {
    expect(pageFailure(retryable, null)).toBe(retryable);
    expect(summaryFailure(retryable, null)).toBe(retryable);
    expect(pageFailure(null, FREE_PLAN_REFUSAL)).toBeNull();
  });

  it("doesn't say a stored refusal twice", () => {
    const f = { ...retryable, reason: PLATFORM_REFUSAL.message, retry: false };
    expect(pageFailure(f, PLATFORM_REFUSAL)?.blocked).toBeUndefined();
  });

  it.skipIf(!rules.hasPlans)("sends only what Billing can lift to Billing", () => {
    expect(refusalFix(FREE_PLAN_REFUSAL.message)).toEqual({ label: "Open Billing", href: "/billing" });
    expect(refusalFix(PLATFORM_REFUSAL.message)).toBeNull();
    expect(refusalFix("This workspace is suspended, so paid checks are off.")).toBeNull();
    expect(refusalFix("Confirm your email address before running paid checks.")).toBeNull();
  });

  it("drops only the advice to run it again", () => {
    expect(withoutRetryAdvice("It timed out. Run it again.")).toBe("It timed out.");
    expect(withoutRetryAdvice("It stopped. Start a new one.")).toBe("It stopped.");
    expect(withoutRetryAdvice("It was rejected, so running it again won't help.")).toBe("It was rejected, so running it again won't help.");
  });

  it("offers no link to the module the callout is on", () => {
    expect(failureLink({ ...retryable, retry: false })).toBeNull();
    expect(failureLink(retryable)).toBeNull();
  });
});

describe("an Analytics source that syncs but stopped sending data", () => {
  const stopped = stoppedData({ at: new Date("2026-11-06T12:00:00Z"), timeZone: "UTC", since: "2026-10-01", reason: "Why.", next: { label: "View", href: "/ga4" } });

  it("counts as stopped only past the named number of days behind the last day the sync asked for", () => {
    expect(DATA_STOPPED_DAYS).toBe(14);
    expect(dataStopped("2026-11-06", "2026-10-01")).toBe(true);
    expect(dataStopped("2026-11-06", "2026-10-23")).toBe(true);
    expect(dataStopped("2026-11-06", "2026-10-24")).toBe(false);
    expect(dataStopped("2026-11-06", "2026-11-06")).toBe(false);
    expect(dataStopped(null, "2026-10-01")).toBe(false);
    expect(dataStopped("2026-11-06", null)).toBe(false);
  });

  it("says the day data stopped, not a failure", () => {
    expect(stopped).toMatchObject({ kind: "stopped", noun: "sync", day: "Nov 6", since: "Oct 1", retry: false });
    expect(failureWords(stopped)).toBe("No data since Oct 1");
    expect(failureAside(stopped)).toBe("synced Nov 6 with nothing newer");
    expect(newerFailed(stopped)).toBe("synced Nov 6 with nothing newer");
    expect(staleCaption("28 days to Oct 1", stopped)).toBe("28 days to Oct 1. Synced Nov 6 with nothing newer.");
    expect(failureLine(stopped)).toBe("No data since Oct 1. Why.");
    expect(failureTone(stopped)).toBe("bad");
    expect(noResultsBecause(stopped)).toBe("No results since Oct 1.");
  });

  it("says it in the sentence and the clause, beside other sources", () => {
    const ga4 = { label: "Analytics", failure: stopped };
    const rank = { label: "Rankings", failure: failed() };
    expect(needsLookSentence([ga4])).toBe("Analytics still syncs, but no data has arrived since Oct 1.");
    expect(needsLookSentence([rank, ga4])).toBe("Rankings need a look: the last check failed on Nov 7. Analytics still syncs, but no data has arrived since Oct 1.");
    expect(needsLookClause([ga4])).toBe("no Analytics data has arrived since Oct 1");
    expect(needsLookClause([rank, ga4])).toBe("the last Rankings check failed on Nov 7, and no Analytics data has arrived since Oct 1");
  });

  it("takes the good or bad tone off a change measured over a window that ended weeks ago", () => {
    expect(withoutTone({ text: "+3", tone: "good", up: true }, stopped)).toEqual({ text: "+3", tone: "muted", up: true });
    expect(withoutTone({ text: "+3", tone: "good", up: true }, failed())).toEqual({ text: "+3", tone: "good", up: true });
    expect(withoutTone(null, stopped)).toBeNull();
    expect(withoutTone({ text: "+3", tone: "good", up: true }, undefined)).toEqual({ text: "+3", tone: "good", up: true });
  });
});
