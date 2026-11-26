import { and, eq, inArray } from "drizzle-orm";
import pLimit, { type LimitFunction } from "p-limit";
import { db } from "@/db";
import { saveInspection } from "@/modules/indexing/inspection";
import { fixes, projects, type FixLiveCheck, type FixSnapshot } from "@/db/schema";
import { analyticsEnabled, track } from "@/lib/analytics/server";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { formatShortDate } from "@/lib/format";
import { OpError, refused, type Actor, type OpOptions } from "@/lib/ops";
import { inScope, workspaceTimeZone, type ProjectScope } from "@/lib/workspace";
import { googleApis } from "@/modules/google/apis";
import { urlInProperty } from "@/modules/google/inspect-url";
import { pageKey } from "@/modules/google/matching";
import { fetchErrorMessage, safeFetch, type FetchResult } from "@/lib/web/fetch";
import { fixesByIds, crawledPage, type Fix } from "./queries";
import { linkedFrom, MANUAL_CODE, pathOf } from "./catalog";
import { offSiteReason, onProjectDomain } from "./domain";
import { pageVariants } from "./measure";
import { checkTarget, linksCheck, linkVerdict, liveCheck, snapshotOf, type LinkSource } from "./live-check";
import { impressionsByPage } from "./sync";

/** The most fixes one call can change: a commit that touches a shared template can fix many. */
export const MAX_APPLY = 100;
/** Each check fetches a page and asks Google about it, so a call stays small. */
export const MAX_VERIFY = 20;

const FETCH_TIMEOUT_MS = 10_000;
/** Linking pages fetched and read at once, over a whole call: each can be 2 MB. One fix's all fit. */
const LINK_PAGES = 20;
/** How long one `verifyFixes` call reads pages for. CloudFront ends a request at 60 seconds. */
const VERIFY_DEADLINE_MS = 45_000;

/**
 * When a check must stop reading pages, in epoch milliseconds. `late` turns true once a page was
 * left unread for time, so the caller knows the answer isn't the page's.
 */
export interface Deadline {
  at: number;
  late: boolean;
}

/** What's left before the deadline, at most one page's timeout. Zero or less marks the check late. */
function timeLeft(deadline: Deadline | undefined): number {
  if (!deadline) return FETCH_TIMEOUT_MS;
  const left = Math.min(FETCH_TIMEOUT_MS, deadline.at - Date.now());
  if (left <= 0) deadline.late = true;
  return left;
}

const OUT_OF_TIME = "SEOpen ran out of time before it read this page.";

type ProjectRef = Pick<typeof projects.$inferSelect, "domain" | "gscProperty">;

async function projectOf(scope: ProjectScope): Promise<ProjectRef> {
  const [p] = await db.select({ domain: projects.domain, gscProperty: projects.gscProperty }).from(projects).where(and(eq(projects.workspaceId, scope.workspaceId), eq(projects.id, scope.projectId)));
  if (!p) throw new OpError("That project doesn't exist.");
  return p;
}

// A stored URL off the project's domain can't send a check somewhere else.
export { onProjectDomain };

/** A few at a time: these fetch other people's sites and read the database. */
async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return out;
}

/**
 * What the page said before the fix. The crawl comes first: an agent may mark a fix applied after it
 * deployed, and then the live page already shows the change.
 */
async function snapshotBefore(scope: ProjectScope, fix: Fix, domain: string): Promise<FixSnapshot> {
  const page = await crawledPage(scope, fix.url);
  if (page) return { title: page.title, description: page.description, words: page.wordCount, h1: page.h1, from: "crawl" };
  if (!onProjectDomain(fix.url, domain)) return { title: null, description: null, words: null, from: null };
  try {
    const r = await safeFetch(fix.url, { timeoutMs: FETCH_TIMEOUT_MS });
    return r.status < 400 && !offSiteReason(r, domain) ? snapshotOf(r.body, "live") : { title: null, description: null, words: null, from: null };
  } catch {
    return { title: null, description: null, words: null, from: null };
  }
}

export interface ApplyInput {
  ids: number[];
  /** The commit that made the change. */
  commit?: string | null;
  note?: string | null;
  files?: string[] | null;
}

export interface ApplyOutcome {
  applied: number[];
  skipped: { id: number; why: string }[];
  message: string;
}

const skipReason = (f: Fix): string | null => {
  if (f.status === "open") return null;
  if (f.status === "dismissed") return "It was dismissed. Reopen it first if that's changed.";
  if (f.status === "resolved") return "It already went away on its own.";
  return "It's already marked applied.";
};

function checkIds(ids: number[], max: number) {
  if (!ids.length) throw new OpError("Name at least one fix.");
  if (ids.length > max) throw new OpError(`That's ${ids.length} fixes, and one call can take ${max}. Send them in smaller groups.`);
}

/** Records that a change was made. It doesn't claim the change is live: `verifyFixes` and the next crawl do that. */
/** A read-only project (after a downgrade) keeps its fixes as they are, as every other change to it is refused. */
async function assertEditable(scope: ProjectScope): Promise<void> {
  const refusal = await projectActionRefusal(scope);
  if (refusal) throw refused(refusal);
}

export async function markFixesApplied(scope: ProjectScope, actor: Actor, input: ApplyInput, opts: OpOptions = {}): Promise<ApplyOutcome> {
  await assertEditable(scope);
  const ids = [...new Set(input.ids)];
  checkIds(ids, MAX_APPLY);
  const rows = await fixesByIds(scope, ids);
  const byId = new Map(rows.map((f) => [f.id, f]));
  const skipped: ApplyOutcome["skipped"] = [];
  const ready: Fix[] = [];
  for (const id of ids) {
    const f = byId.get(id);
    const why = f ? skipReason(f) : "There's no fix with that id in this project.";
    if (why) skipped.push({ id, why });
    else ready.push(f!);
  }
  if (opts.dryRun) return { applied: ready.map((f) => f.id), skipped, message: `Would mark ${fixCount(ready.length)} as applied.` };

  const { domain } = await projectOf(scope);
  const now = new Date();
  await inBatches(ready, 5, async (f) => {
    const before = await snapshotBefore(scope, f, domain);
    await db
      .update(fixes)
      .set({ status: "applied", appliedAt: now, appliedVia: actor.source, appliedCommit: input.commit ?? null, appliedNote: input.note ?? null, appliedFiles: input.files ?? null, before, liveAt: null, liveCheck: null, recrawledAt: null, inspectedAt: null, results: null, updatedAt: now })
      .where(and(inScope(fixes, scope), eq(fixes.id, f.id), eq(fixes.status, "open")));
  });
  if (analyticsEnabled() && ready.length) track(actor.userId, "fixes_applied", { project_id: scope.projectId, count: ready.length, via: actor.source }, { workspaceId: scope.workspaceId });
  return { applied: ready.map((f) => f.id), skipped, message: `Marked ${fixCount(ready.length)} as applied. Once it's deployed, call verify_fix to check the live pages.` };
}

const fixCount = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "fix" : "fixes"}`;

/** The most pages one logged change can name. */
export const MAX_RECORD = 50;
/** The longest `expect`: a title or a sentence, not a page. */
export const MAX_EXPECT = 300;
/** The most pages one logged change can say now link to its page. */
export const MAX_LINKED_FROM = 20;

export interface RecordInput {
  /** Full URLs or paths on the project's site. */
  urls: string[];
  commit?: string | null;
  note?: string | null;
  files?: string[] | null;
  /** Text the live page should now contain, such as the new title. */
  expect?: string | null;
  /** Pages that now link to the one page logged: the check looks for the links there. */
  linkedFrom?: string[] | null;
}

export interface RecordOutcome {
  /** One per page recorded, or that would be in a preview: `id` is null for a page with no record yet. */
  recorded: { id: number | null; url: string }[];
  skipped: { url: string; why: string }[];
  message: string;
}

/** A logged change in these states is finished with, so logging the page again starts a new record. */
const SETTLED = ["open", "measured", "resolved", "dismissed"];

/** A page on the project's site as one address: a path joins the domain; a full URL must be on it. */
export function siteUrl(input: string, domain: string): { url: string } | { why: string } {
  const raw = input.trim();
  if (!raw) return { why: "That's empty." };
  let u: URL;
  try {
    u = raw.startsWith("/") ? new URL(raw, `https://${domain}`) : new URL(raw);
  } catch {
    return { why: "That isn't a URL or a path such as /pricing." };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { why: "Only http and https pages can be checked." };
  if (!onProjectDomain(u.href, domain)) return { why: `That isn't on ${domain}.` };
  u.hash = "";
  return { url: u.href };
}

/** Why a page's logged change can't be logged again yet, with its status and date. */
function inProgressReason(f: Fix, timeZone: string): string {
  const day = (d: Date | null) => formatShortDate(d, timeZone);
  if (f.status === "live") return `A change to this page went live on ${day(f.liveAt)} and is being measured. Log another once its 28-day result is in.`;
  return `A change to this page was logged on ${day(f.appliedAt)} and is waiting to go live. Check it again, or dismiss it, before logging another.`;
}

/** What the page says now, read from the live page: the change may not be deployed yet. The latest crawl stands in if the page can't be fetched. */
async function snapshotNow(scope: ProjectScope, url: string, domain: string): Promise<FixSnapshot> {
  try {
    const r = await safeFetch(url, { timeoutMs: FETCH_TIMEOUT_MS });
    if (r.status < 400 && !offSiteReason(r, domain)) return snapshotOf(r.body, "live");
  } catch {
    // Falls through to the crawl.
  }
  const page = await crawledPage(scope, url);
  return page ? { title: page.title, description: page.description, words: page.wordCount, h1: page.h1, from: "crawl" } : { title: null, description: null, words: null, h1: null, from: null };
}

const clean = (s: string | null | undefined) => (s?.trim() ? s.trim() : null);

/**
 * The pages a change added links on, as addresses on the site. They name one page's new links, so
 * the call logs one page, and a page can't count as linking to itself.
 */
function linkSources(input: RecordInput, domain: string): string[] {
  const raw = (input.linkedFrom ?? []).filter((u) => u.trim());
  if (!raw.length) return [];
  if (input.urls.length !== 1) throw new OpError("linked_from names the pages that now link to one page, so log that one page in the call.");
  if (raw.length > MAX_LINKED_FROM) throw new OpError(`That's ${raw.length} linking pages, and one change can name ${MAX_LINKED_FROM}. Log the pages with the most traffic.`);
  const target = siteUrl(input.urls[0], domain);
  const out: string[] = [];
  for (const u of raw) {
    const r = siteUrl(u, domain);
    if ("why" in r) throw new OpError(`${u} in linked_from: ${r.why}`);
    if ("url" in target && pageVariants(target.url).includes(pageVariants(r.url)[0])) throw new OpError(`${u} is the page being logged, so it can't count as a page linking to it.`);
    if (!out.some((o) => pageVariants(o).includes(pageVariants(r.url)[0]))) out.push(r.url);
  }
  return out;
}

/**
 * Logs a change made without a finding behind it, one `manual` record per page, so it gets the same
 * live check, recrawl check and 7, 14 and 28 day results as any fix. A page whose earlier logged
 * change is still applied or live is refused; one that's settled starts over as a new record.
 */
export async function recordChanges(scope: ProjectScope, actor: Actor, input: RecordInput, opts: OpOptions = {}): Promise<RecordOutcome> {
  await assertEditable(scope);
  if (!input.urls.length) throw new OpError("Name at least one page.");
  if (input.urls.length > MAX_RECORD) throw new OpError(`That's ${input.urls.length} pages, and one call can take ${MAX_RECORD}. Send them in smaller groups.`);
  const expect = clean(input.expect);
  if (expect && expect.length > MAX_EXPECT) throw new OpError(`The text to look for is ${expect.length} characters. Keep it to ${MAX_EXPECT}, such as the new title.`);
  const note = clean(input.note);
  const { domain } = await projectOf(scope);
  const sources = linkSources(input, domain);

  const skipped: RecordOutcome["skipped"] = [];
  const wanted: string[] = [];
  for (const raw of input.urls) {
    const r = siteUrl(raw, domain);
    if ("why" in r) skipped.push({ url: raw, why: r.why });
    else if (!wanted.includes(r.url)) wanted.push(r.url);
  }

  // A page logged before under another spelling (www, http, a trailing slash) is the same record.
  const variants = [...new Set(wanted.flatMap(pageVariants))];
  const existing = variants.length ? await db.select().from(fixes).where(and(inScope(fixes, scope), eq(fixes.source, "manual"), eq(fixes.code, MANUAL_CODE), inArray(fixes.url, variants))) : [];
  const timeZone = existing.some((f) => !SETTLED.includes(f.status)) ? await workspaceTimeZone(scope) : "UTC";
  const ready: { url: string; prior: Fix | null }[] = [];
  for (const url of wanted) {
    const prior = existing.find((f) => pageVariants(url).includes(f.url)) ?? null;
    if (prior && !SETTLED.includes(prior.status)) skipped.push({ url, why: inProgressReason(prior, timeZone) });
    else if (!ready.some((r) => r.url === (prior?.url ?? url))) ready.push({ url: prior?.url ?? url, prior });
  }
  const pages = (n: number) => `${n.toLocaleString("en-US")} ${n === 1 ? "page" : "pages"}`;
  if (opts.dryRun) return { recorded: ready.map((r) => ({ id: r.prior?.id ?? null, url: r.url })), skipped, message: `Would log a change on ${pages(ready.length)}.` };

  const now = new Date();
  const recorded: RecordOutcome["recorded"] = [];
  // The page's own 28 days, as list_fixes shows for any fix. The daily job keeps it current.
  const impressions = ready.length ? await impressionsByPage(scope) : new Map<string, number>();
  await inBatches(ready, 5, async ({ url, prior }) => {
    const before = await snapshotNow(scope, url, domain);
    // A new record, all through: nothing from an earlier change to this page carries over.
    const evidence = expect || sources.length ? { ...(expect ? { expect } : {}), ...(sources.length ? { linked_from: sources } : {}) } : null;
    const record = { status: "applied", detail: note, evidence, pageImpressions: impressions.get(pageKey(url)) ?? 0, firstSeenAt: now, lastSeenAt: now, appliedAt: now, appliedVia: actor.source, appliedCommit: clean(input.commit), appliedNote: note, appliedFiles: input.files?.length ? input.files : null, before, liveAt: null, liveCheck: null, recrawledAt: null, inspectedAt: null, results: null, resolvedAt: null, dismissedAt: null, dismissedReason: null, reopenedAt: null, updatedAt: now };
    const [row] = prior
      ? await db
          .update(fixes)
          .set(record)
          .where(and(inScope(fixes, scope), eq(fixes.id, prior.id), inArray(fixes.status, SETTLED)))
          .returning({ id: fixes.id })
      : await db
          .insert(fixes)
          .values({ ...scope, source: "manual", code: MANUAL_CODE, url, ...record, createdAt: now })
          .onConflictDoNothing()
          .returning({ id: fixes.id });
    if (row) recorded.push({ id: row.id, url });
    else skipped.push({ url, why: "Another call logged a change on this page just now." });
  });
  return { recorded, skipped, message: `Logged a change on ${pages(recorded.length)}. Once it's deployed, call verify_fix with the ids to check the live pages.` };
}

/** Someone decided not to fix these. Syncs leave them alone until they're reopened. */
export async function dismissFixes(scope: ProjectScope, actor: Actor, input: { ids: number[]; reason?: string | null }, opts: OpOptions = {}): Promise<{ dismissed: number[]; skipped: { id: number; why: string }[]; message: string }> {
  await assertEditable(scope);
  const ids = [...new Set(input.ids)];
  checkIds(ids, MAX_APPLY);
  const rows = await fixesByIds(scope, ids);
  const byId = new Map(rows.map((f) => [f.id, f]));
  const dismissed: number[] = [];
  const skipped: { id: number; why: string }[] = [];
  for (const id of ids) {
    const f = byId.get(id);
    if (!f) skipped.push({ id, why: "There's no fix with that id in this project." });
    else if (f.status !== "open" && f.status !== "applied") skipped.push({ id, why: `It's already ${f.status}.` });
    else dismissed.push(id);
  }
  if (opts.dryRun) return { dismissed, skipped, message: `Would dismiss ${fixCount(dismissed.length)}.` };
  if (dismissed.length) {
    const now = new Date();
    await db.update(fixes).set({ status: "dismissed", dismissedAt: now, dismissedReason: input.reason ?? null, updatedAt: now }).where(and(inScope(fixes, scope), inArray(fixes.id, dismissed)));
  }
  if (analyticsEnabled() && dismissed.length) track(actor.userId, "fixes_dismissed", { project_id: scope.projectId, count: dismissed.length, via: actor.source }, { workspaceId: scope.workspaceId });
  return { dismissed, skipped, message: `Dismissed ${fixCount(dismissed.length)}.` };
}

/** Puts a dismissed fix back on the list. */
export async function reopenFix(scope: ProjectScope, id: number): Promise<void> {
  await assertEditable(scope);
  const now = new Date();
  await db.update(fixes).set({ status: "open", dismissedAt: null, dismissedReason: null, updatedAt: now }).where(and(inScope(fixes, scope), eq(fixes.id, id), eq(fixes.status, "dismissed")));
}

/**
 * Fetches the page and compares it with the finding. A page it can't reach is a page it can't judge.
 * `linkPages` limits the linking pages read at once, shared by the checks of one call.
 */
export async function runLiveCheck(fix: Pick<Fix, "code" | "url" | "detail" | "before" | "evidence">, domain: string, now = new Date(), linkPages: LimitFunction = pLimit(LINK_PAGES), deadline?: Deadline): Promise<FixLiveCheck> {
  const checkedAt = now.toISOString();
  const sources = fix.code === MANUAL_CODE ? linkedFrom(fix.evidence) : [];
  if (sources.length) return runLinksCheck(fix, sources, domain, checkedAt, linkPages, deadline);
  const target = checkTarget(fix.code, fix.url);
  if (!onProjectDomain(target, domain)) return { state: "cannot_check", saw: `${target} isn't on ${domain}, so SEOpen didn't fetch it.`, checkedAt, status: null };
  const left = timeLeft(deadline);
  if (left <= 0) return { state: "cannot_check", saw: OUT_OF_TIME, checkedAt, status: null };
  try {
    const r = await safeFetch(target, { timeoutMs: left });
    const away = offSiteReason(r, domain);
    if (away) return { state: "cannot_check", saw: away, checkedAt, status: r.status };
    return { ...liveCheck(fix, { status: r.status, html: r.body, headers: r.headers }, fix.before), checkedAt, status: r.status };
  } catch (err) {
    if (deadline && left < FETCH_TIMEOUT_MS && Date.now() >= deadline.at) {
      deadline.late = true;
      return { state: "cannot_check", saw: OUT_OF_TIME, checkedAt, status: null };
    }
    return { state: "cannot_check", saw: fetchErrorMessage(err), checkedAt, status: null };
  }
}

/** One linking page, fetched and judged, so its HTML needn't be kept. `status` is null when nothing was read. */
async function readLinkSource(target: string, url: string, domain: string, deadline?: Deadline): Promise<LinkSource & { status: number | null }> {
  const unread = { url, verdict: "unread", status: null } as const;
  if (!onProjectDomain(url, domain)) return unread;
  // Checked as the page's turn comes, since it may have waited behind others.
  const left = timeLeft(deadline);
  if (left <= 0) return unread;
  let r: FetchResult;
  try {
    r = await safeFetch(url, { timeoutMs: left });
  } catch {
    if (deadline && left < FETCH_TIMEOUT_MS && Date.now() >= deadline.at) deadline.late = true;
    return unread;
  }
  if (offSiteReason(r, domain)) return unread;
  return { url, verdict: linkVerdict(target, url, { status: r.status, html: r.body, headers: r.headers }), status: r.status };
}

/**
 * A logged change with `linked_from`: each linking page is fetched and must link to the page. Once
 * they all do, a named `expect` is looked for on the page itself as usual. A few pages at a time,
 * and only what each one said is kept.
 */
async function runLinksCheck(fix: Pick<Fix, "code" | "url" | "detail" | "before" | "evidence">, sources: string[], domain: string, checkedAt: string, linkPages: LimitFunction, deadline?: Deadline): Promise<FixLiveCheck> {
  const read = await Promise.all(sources.map((url) => linkPages(() => readLinkSource(fix.url, url, domain, deadline))));
  const links = linksCheck(fix.url, read);
  const status = read.find((r) => r.status !== null)?.status ?? null;
  // A page left unread for time says nothing about the page: say so rather than blame it.
  if (links.state === "cannot_check" && deadline?.late) return { state: "cannot_check", saw: `SEOpen ran out of time before it read every page that should link to ${pathOf(fix.url)}.`, checkedAt, status };
  if (links.state !== "fixed" || !fix.evidence?.expect) return { ...links, checkedAt, status };
  const page = await runLiveCheck({ ...fix, evidence: { expect: fix.evidence.expect } }, domain, new Date(checkedAt), undefined, deadline);
  return page.state === "fixed" ? { ...page, saw: `${links.saw} ${page.saw}` } : page;
}

export interface GoogleView {
  verdict: string | null;
  coverage: string | null;
  lastCrawl: string | null;
  link: string | null;
  error?: string;
}

/** Asks Search Console about a page and keeps the answer in the inspection history. */
export async function inspectForFix(scope: ProjectScope, property: string, url: string): Promise<GoogleView> {
  const api = await googleApis(scope.workspaceId);
  const r = await api.gsc.inspect(property, url);
  await saveInspection(scope, url, r);
  return { verdict: r.verdict ?? null, coverage: r.coverageState ?? null, lastCrawl: r.lastCrawlTime ?? null, link: r.inspectionResultLink ?? null };
}

/** Applies a live check and an inspection to a record: what `verifyFixes` and the daily job both do. */
export async function recordCheck(scope: ProjectScope, fix: Fix, check: FixLiveCheck, google: GoogleView | null, now = new Date()): Promise<Pick<Fix, "status" | "liveAt" | "recrawledAt">> {
  const indexedNow = fix.code === "gsc-not-indexed" && google?.verdict === "PASS";
  const goesLive = fix.status === "applied" && (check.state === "fixed" || indexedNow);
  const liveAt = goesLive ? now : fix.liveAt;
  const since = liveAt ?? fix.appliedAt;
  const crawled = google?.lastCrawl ? new Date(google.lastCrawl) : null;
  const recrawledAt = crawled && since && crawled > since ? crawled : fix.recrawledAt;
  const status = goesLive ? "live" : fix.status;
  await db
    .update(fixes)
    .set({ status, liveAt, liveCheck: check, recrawledAt, inspectedAt: google && !google.error ? now : fix.inspectedAt, updatedAt: now })
    .where(and(inScope(fixes, scope), eq(fixes.id, fix.id)));
  return { status, liveAt, recrawledAt };
}

export interface VerifyOutcome {
  id: number;
  url: string;
  status: string;
  live_check: { state: FixLiveCheck["state"]; saw: string };
  google: { verdict: string | null; coverage: string | null; last_crawl: string | null; recrawled_since_fix: boolean; inspection_link: string | null; note?: string } | null;
  next_step: string;
}

/** Search Console's answer, or null when it doesn't come before the deadline. The request carries on, and its answer is still saved. */
async function beforeDeadline<T>(work: Promise<T>, at: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), Math.max(0, at - Date.now()))));
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

function nextStep(status: string, check: FixLiveCheck, recrawled: boolean, google: GoogleView | null, again: string): string {
  if (status === "open") return check.state === "fixed" ? "This looks fixed on the live page already. If you changed it, call mark_fix_applied so its results get measured." : "This fix isn't marked applied yet.";
  if (check.state === "page_broken") return "The live page is failing. Look at that before anything else.";
  if (status === "applied" && check.state === "still_there") return `The change isn't on the live page. Check that it was deployed and that nothing cached the old page, then ${again}.`;
  if (status === "applied" && check.state === "cannot_check") return "SEOpen can't confirm this from the page. The next crawl will, and results are measured from the day it was marked applied.";
  if (!google) return "It's live. Connect Search Console to see when Google crawls it and to measure the results.";
  if (google.error) return "It's live. Search Console couldn't answer just now, and the daily check will try again.";
  if (!recrawled && google.link) return `It's live, and Google hasn't crawled it since. To speed that up, the site's owner can open ${google.link} and choose Request Indexing. There's no way to do that from an API.`;
  return "It's live and Google has crawled it. Results come at 7, 14 and 28 days.";
}

/**
 * Checks fixes against the live page and Google, and moves an applied fix to live when the change is there.
 * Results keep the order of `ids`. An id with no fix in this project is skipped with the reason, as `dismissFixes` does.
 * `again` is how the caller checks again, in `next_step`: the MCP tool by default, or the app's Check now.
 * The call stops reading pages at `deadline` (45 seconds from now by default). A fix it didn't finish
 * is reported as `cannot_check` with the reason, and its record is left as it was.
 */
export async function verifyFixes(scope: ProjectScope, ids: number[], { again = "call verify_fix again", deadline = Date.now() + VERIFY_DEADLINE_MS }: { again?: string; deadline?: number } = {}): Promise<{ fixes: VerifyOutcome[]; skipped: { id: number; why: string }[] }> {
  await assertEditable(scope);
  const unique = [...new Set(ids)];
  checkIds(unique, MAX_VERIFY);
  const byId = new Map((await fixesByIds(scope, unique)).map((f) => [f.id, f]));
  const rows = unique.flatMap((id) => byId.get(id) ?? []);
  const skipped = unique.filter((id) => !byId.has(id)).map((id) => ({ id, why: "There's no fix with that id in this project." }));
  if (!rows.length) return { fixes: [], skipped };
  const project = await projectOf(scope);
  const linkPages = pLimit(LINK_PAGES);
  const checked = await inBatches(rows, 5, async (fix): Promise<VerifyOutcome> => {
    const clock: Deadline = { at: deadline, late: false };
    const check = await runLiveCheck(fix, project.domain, new Date(), linkPages, clock);
    if (clock.late) {
      // Not finished, so nothing is saved, and Google isn't asked about a page SEOpen didn't read.
      return { id: fix.id, url: fix.url, status: fix.status, live_check: { state: check.state, saw: check.saw }, google: null, next_step: `SEOpen ran out of time before it finished this check, so nothing changed. To finish it, ${again}.` };
    }
    let google: GoogleView | null = null;
    if (project.gscProperty && urlInProperty(fix.url, project.gscProperty)) {
      const late: GoogleView = { verdict: null, coverage: null, lastCrawl: null, link: null, error: "Search Console didn't answer in time." };
      try {
        google = Date.now() < deadline ? ((await beforeDeadline(inspectForFix(scope, project.gscProperty, fix.url), deadline)) ?? late) : late;
      } catch (err) {
        console.error("[fixes.verify]", err);
        google = { verdict: null, coverage: null, lastCrawl: null, link: null, error: "Search Console didn't answer." };
      }
    }
    const after = fix.status === "open" ? { status: "open", liveAt: null, recrawledAt: null } : await recordCheck(scope, fix, check, google);
    const recrawled = !!after.recrawledAt;
    return {
      id: fix.id,
      url: fix.url,
      status: after.status,
      live_check: { state: check.state, saw: check.saw },
      google: google ? { verdict: google.verdict, coverage: google.coverage, last_crawl: google.lastCrawl, recrawled_since_fix: recrawled, inspection_link: google.link, note: google.error } : null,
      next_step: nextStep(after.status, check, recrawled, google, again),
    };
  });
  return { fixes: checked, skipped };
}
