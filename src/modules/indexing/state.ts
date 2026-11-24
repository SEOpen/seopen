/**
 * The indexing module's rules, pure so they can be tested: what Google's answer means for a page,
 * which pages the worker inspects next, and which go to IndexNow.
 */
import { randomBytes } from "node:crypto";

/** Pages kept per project: the sitemap's first ones. URL Inspection reaches about 400 a day, so more would wait weeks. */
export const MAX_PAGES = 5000;
/** Sitemaps read from an index. */
export const MAX_CHILD_SITEMAPS = 50;
/**
 * Inspections the worker makes per project per day. Google allows 2,000 a day per property, and
 * the URL inspection tab and inspect_url use the same quota, so most of it stays free for them.
 */
export const INSPECTIONS_PER_DAY = 400;
/** Inspections per run. The job runs every four hours, so a day's share spreads over the day. */
export const INSPECTIONS_PER_RUN = 100;
/** How long a page Google hasn't indexed waits before it's inspected again. */
export const RECHECK_NOT_INDEXED_DAYS = 2;
/** How long a page the owner requested waits before it's inspected again, so it moves to Now indexed soon after Google takes it. */
export const RECHECK_REQUESTED_DAYS = 1;
/** A page requested longer ago than this, and still not indexed, goes back in the queue to request again. */
export const REREQUEST_DAYS = 7;
/**
 * Request Indexing presses a day. Google doesn't publish the limit; owners report about 10 a day per
 * property, so the page says "about".
 */
export const REQUESTS_PER_DAY = 10;
/** How long an indexed page waits before it's inspected again. */
export const RECHECK_INDEXED_DAYS = 14;
/** IndexNow takes up to 10,000 URLs in one request. */
export const INDEXNOW_BATCH = 10_000;
/** How long a page that became indexed stays in the Now indexed list. */
export const NOW_INDEXED_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * What Google's last answer means:
 * - `indexed`: Google has it.
 * - `waiting`: Google hasn't found it, found it and not crawled it, or crawled it and not indexed it. Request Indexing helps.
 * - `blocked`: something stops indexing (noindex, robots.txt, an error, a redirect). Fix the page first.
 * - `duplicate`: Google counts it as a copy of another page and indexes that one.
 * - `other`: not indexed for a reason not listed above.
 * - `unchecked`: not inspected yet. `error`: the inspection failed.
 */
export type IndexStatus = "indexed" | "waiting" | "blocked" | "duplicate" | "other" | "unchecked" | "error";

export const NOT_INDEXED: IndexStatus[] = ["waiting", "blocked", "duplicate", "other"];

export interface InspectedFields {
  inspectedAt: Date | null;
  verdict: string | null;
  coverageState: string | null;
  robotsTxtState?: string | null;
  indexingState?: string | null;
  pageFetchState?: string | null;
}

export function indexStatus(p: InspectedFields): IndexStatus {
  if (!p.inspectedAt) return "unchecked";
  if (p.verdict === "ERROR") return "error";
  if (p.verdict === "PASS") return "indexed";
  const coverage = (p.coverageState ?? "").toLowerCase();
  if (/unknown to google|discovered|crawled/.test(coverage)) return "waiting";
  if (/duplicate|alternate|canonical/.test(coverage)) return "duplicate";
  if (p.robotsTxtState === "DISALLOWED" || (p.indexingState ?? "").startsWith("BLOCKED")) return "blocked";
  if (p.pageFetchState && p.pageFetchState !== "SUCCESSFUL" && p.pageFetchState !== "PAGE_FETCH_STATE_UNSPECIFIED") return "blocked";
  if (/noindex|robots|404|server error|5xx|redirect|unauthori[sz]ed|forbidden|4xx|blocked/.test(coverage)) return "blocked";
  return "other";
}

/** What to do about each status, in a sentence. */
export const STATUS_ADVICE: Record<IndexStatus, string> = {
  indexed: "Google has indexed this page.",
  waiting: "Google hasn't indexed this page. Open it in Search Console and press Request Indexing.",
  blocked: "Something stops Google indexing this page. Fix it first; Request Indexing won't help until then.",
  duplicate: "Google treats this as a copy of another page. Check its canonical tag points where you want.",
  other: "Google hasn't indexed this page. Open it in Search Console to see why.",
  unchecked: "Not inspected yet. The worker checks a few hundred pages a day.",
  error: "The last inspection failed. It's tried again on a later run.",
};

/**
 * The advice for one page: a waiting page's sentence follows Google's own coverage words, since
 * "unknown to Google" and "crawled, not indexed" call for different next steps.
 */
export function adviceFor(status: IndexStatus, coverage: string | null): string {
  if (status !== "waiting") return STATUS_ADVICE[status];
  const c = (coverage ?? "").toLowerCase();
  if (c.includes("unknown to google")) return "Google hasn't found this page yet. Press Request Indexing in Search Console, and link to it from a page Google has indexed.";
  if (c.includes("discovered")) return "Google knows the page but hasn't crawled it yet. Open it in Search Console and press Request Indexing.";
  if (c.includes("crawled")) return "Google crawled the page and chose not to index it yet. Request Indexing can help; if it stays out, make the page more useful or link to it more.";
  return STATUS_ADVICE.waiting;
}

export const STATUS_LABEL: Record<IndexStatus, string> = {
  indexed: "Indexed",
  waiting: "Request indexing",
  blocked: "Fix first",
  duplicate: "Duplicate",
  other: "Not indexed",
  unchecked: "Not checked",
  error: "Check failed",
};

export interface PickRow extends InspectedFields {
  url: string;
  firstSeenAt: Date;
  requestedAt?: Date | null;
}

/** The owner pressed Request Indexing after Google's last answer, so the next answer may differ. */
export const requestedSinceInspection = (r: { requestedAt?: Date | null; inspectedAt: Date | null }) => !!r.requestedAt && (!r.inspectedAt || r.requestedAt > r.inspectedAt);

/**
 * The pages to inspect next, at most `limit`: pages never inspected (oldest in the sitemap first),
 * then pages the owner requested since Google's last answer (after a day), then other pages Google
 * hadn't indexed, then indexed pages due a recheck, oldest answer first.
 */
export function pickForInspection<T extends PickRow>(rows: T[], now: Date, limit: number): T[] {
  if (limit <= 0) return [];
  const t = now.getTime();
  const tier = (r: T): number | null => {
    if (!r.inspectedAt) return 0;
    const age = t - r.inspectedAt.getTime();
    const status = indexStatus(r);
    if (status === "indexed") return age >= RECHECK_INDEXED_DAYS * DAY_MS ? 3 : null;
    if (requestedSinceInspection(r)) return age >= RECHECK_REQUESTED_DAYS * DAY_MS ? 1 : null;
    return age >= RECHECK_NOT_INDEXED_DAYS * DAY_MS ? 2 : null;
  };
  return rows
    .map((r) => ({ r, tier: tier(r) }))
    .filter((x): x is { r: T; tier: number } => x.tier !== null)
    .sort((a, b) => a.tier - b.tier || (a.r.inspectedAt?.getTime() ?? a.r.firstSeenAt.getTime()) - (b.r.inspectedAt?.getTime() ?? b.r.firstSeenAt.getTime()) || a.r.url.localeCompare(b.r.url))
    .slice(0, limit)
    .map((x) => x.r);
}

/**
 * Which pages to request first: Google hasn't found the page at all, then it found it and hasn't
 * crawled it, then it crawled it and passed. A request helps the first most and the last least.
 */
export function requestRank(coverage: string | null): number {
  const c = (coverage ?? "").toLowerCase();
  if (c.includes("unknown to google")) return 0;
  if (c.includes("discovered")) return 1;
  if (c.includes("crawled")) return 2;
  return 3;
}

/** A request still counts: made within REREQUEST_DAYS. After that the page goes back in the queue. */
export const requestPending = (requestedAt: Date | null, now: Date) => !!requestedAt && now.getTime() - requestedAt.getTime() < REREQUEST_DAYS * DAY_MS;

/** The first path folder, "/glossary/clicks" → "glossary"; "" for the home page. */
export function sectionOf(url: string): string {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] ?? "";
  } catch {
    return "";
  }
}

/**
 * Indexed pages to link from, for a page Google hasn't indexed: same section first, then the pages
 * with the most Search Console clicks, then the home page, never the page itself.
 */
export function linkFrom(target: string, indexed: { url: string; clicks: number }[], n = 3): string[] {
  const section = sectionOf(target);
  const home = (u: string) => {
    try {
      return new URL(u).pathname === "/";
    } catch {
      return false;
    }
  };
  return indexed
    .filter((p) => p.url !== target)
    .map((p) => ({ ...p, same: section !== "" && sectionOf(p.url) === section ? 1 : 0, home: home(p.url) ? 1 : 0 }))
    .sort((a, b) => b.same - a.same || b.clicks - a.clicks || b.home - a.home || a.url.localeCompare(b.url))
    .slice(0, n)
    .map((p) => p.url);
}

/** When the inspection that just ran found a page newly indexed, that time; null when it isn't, or always was. */
export function nextIndexedAt(before: { verdict: string | null; indexedAt: Date | null }, verdict: string | null, now: Date): Date | null {
  if (verdict !== "PASS") return null;
  if (before.indexedAt) return before.indexedAt;
  return before.verdict && before.verdict !== "PASS" ? now : null;
}

export interface SubmitRow {
  url: string;
  lastmod: string | null;
  submittedAt: Date | null;
  submittedLastmod: string | null;
}

/** A URL's host, lower case, or null when it isn't an http(s) URL. */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The pages to send to IndexNow: on the key's host, and never sent or changed since (a new `<lastmod>`). */
export function indexNowBatch<T extends SubmitRow>(rows: T[], host: string, limit = INDEXNOW_BATCH): T[] {
  const h = host.toLowerCase();
  return rows.filter((r) => hostOf(r.url) === h && (!r.submittedAt || (r.lastmod !== null && r.lastmod !== r.submittedLastmod))).slice(0, limit);
}

/** The host most of the sitemap's pages are on, for the key file. Null for an empty sitemap. */
export function mainHost(urls: string[]): string | null {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const h = hostOf(u);
    if (h) counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  let best: string | null = null;
  for (const [h, n] of counts) if (best === null || n > counts.get(best)!) best = h;
  return best;
}

/** A new IndexNow key: 32 hex characters (IndexNow takes 8 to 128 of a-z, A-Z, 0-9 and dashes). */
export function newIndexNowKey(): string {
  return randomBytes(16).toString("hex");
}

export const keyFileUrl = (host: string, key: string) => `https://${host}/${key}.txt`;

/** Whether a fetched key file holds the key: the file is the key alone, give or take whitespace. */
export function keyFileMatches(status: number, body: string, key: string): boolean {
  return status === 200 && body.trim() === key;
}

/** What IndexNow's answer to a submission means. 200 and 202 are accepted. */
export function indexNowAnswer(status: number): { ok: boolean; keyRejected: boolean; message: string } {
  if (status === 200) return { ok: true, keyRejected: false, message: "IndexNow accepted the pages." };
  if (status === 202) return { ok: true, keyRejected: false, message: "IndexNow accepted the pages and is still checking the key." };
  if (status === 403) return { ok: false, keyRejected: true, message: "IndexNow couldn't find the key file on the site, so it refused the pages." };
  if (status === 422) return { ok: false, keyRejected: true, message: "IndexNow said the pages aren't on the key's site." };
  if (status === 429) return { ok: false, keyRejected: false, message: "IndexNow asked us to slow down. The pages go again on the next run." };
  if (status === 400) return { ok: false, keyRejected: false, message: "IndexNow said the request was malformed." };
  return { ok: false, keyRejected: false, message: `IndexNow answered HTTP ${status}. The pages go again on the next run.` };
}
