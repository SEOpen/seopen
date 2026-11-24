/**
 * The alert rules as pure functions over data a check already has (src/modules/alerts/rules.ts).
 * Each returns what fired and the keys that are fine now, so an open alert for one of those closes.
 * A key the check didn't look at is in neither list: its alert stays as it was.
 */
import { formatNumber } from "@/lib/format";
import type { AccessReport } from "@/modules/audit/access";

export interface Finding {
  key: string;
  title: string;
  detail: string | null;
  screen: string;
}

export interface Detected {
  findings: Finding[];
  /** Keys this check saw working. */
  fine: string[];
}

/** One page address however Search Console or the crawler wrote it: no fragment, a lowercase host, no trailing slash past the root. */
export function pageKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${u.protocol}//${u.host.toLowerCase()}${path}${u.search}`;
  } catch {
    return url;
  }
}

/** "/pricing", or the whole address when it isn't one. */
export function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}

const NOINDEX: Record<string, string> = { meta_tag: "a noindex tag", http_header: "a noindex header" };

const clicksLine = (clicks: number) => `${formatNumber(clicks)} Search Console click${clicks === 1 ? "" : "s"} in the last 28 days`;

/**
 * Rule page-broken: crawled pages that had Search Console clicks and now answer 4xx or 5xx, or
 * carry noindex. `clicked` is keyed by `pageKey`. A page the crawl didn't reach isn't judged.
 */
export function pageBroken(o: {
  crawlId: number;
  clicked: Map<string, number>;
  pages: { url: string; statusCode: number | null }[];
  nonIndexable: { url: string; reason: string | null }[];
}): Detected {
  const noindex = new Map(o.nonIndexable.filter((n) => NOINDEX[n.reason ?? ""]).map((n) => [pageKey(n.url), NOINDEX[n.reason ?? ""]]));
  const findings: Finding[] = [];
  const fine: string[] = [];
  const seen = new Set<string>();
  for (const p of o.pages) {
    const key = pageKey(p.url);
    const clicks = o.clicked.get(key);
    if (!clicks || seen.has(key) || p.statusCode == null) continue;
    seen.add(key);
    if (p.statusCode >= 400) {
      const status = p.statusCode >= 500 ? "5xx" : "4xx";
      findings.push({ key, title: `${pathOf(p.url)} answers ${p.statusCode}`, detail: clicksLine(clicks), screen: `/audit/pages?crawl=${o.crawlId}&status=${status}` });
    } else if (noindex.has(key)) {
      findings.push({ key, title: `${pathOf(p.url)} is set to noindex`, detail: `It has ${noindex.get(key)}. ${clicksLine(clicks)}.`, screen: `/audit/issues?crawl=${o.crawlId}&category=indexability` });
    } else fine.push(key);
  }
  return { findings, fine };
}

export interface AccessSide {
  report: AccessReport | null;
  /** The crawl's search-bot-blocked issues. */
  blocked: { url: string; detail: string | null }[];
}

/** Whether robots.txt was read, so what it allows means something. */
const robotsRead = (report: AccessReport | null): report is AccessReport => !!report && !report.robots.error;

/**
 * Rule bot-blocked: key pages robots.txt now keeps a search crawler off, which the previous crawl's
 * check looked at and found open. With no earlier check to compare with, nothing is "newly" blocked.
 */
export function botBlocked(o: { crawlId: number; current: AccessSide; previous: AccessSide | null }): Detected {
  if (!robotsRead(o.current.report)) return { findings: [], fine: [] };
  const now = new Map(o.current.blocked.map((b) => [pageKey(b.url), b]));
  const fine = o.current.report.keyPages.map(pageKey).filter((k) => !now.has(k));
  const prev = o.previous;
  if (!prev || !robotsRead(prev.report)) return { findings: [], fine };
  const checkedBefore = new Set(prev.report.keyPages.map(pageKey));
  const blockedBefore = new Set(prev.blocked.map((b) => pageKey(b.url)));
  const findings: Finding[] = [];
  for (const [key, b] of now) {
    if (!checkedBefore.has(key) || blockedBefore.has(key)) continue;
    findings.push({
      key,
      title: `robots.txt now blocks search crawlers from ${pathOf(b.url)}`,
      detail: b.detail ? `Blocked: ${b.detail}. The previous crawl's check found it open.` : "The previous crawl's check found it open.",
      screen: `/audit/issues?crawl=${o.crawlId}&category=access`,
    });
  }
  return { findings, fine };
}

export interface RankRow {
  keywordId: number;
  keyword: string;
  locationCode: number | null;
  position: number | null;
  depth: number;
  notChecked: boolean;
  /** The keyword's latest confirmed result before this check, from the same place. */
  previous: { position: number | null; date: string } | null;
}

export const rankKey = (keywordId: number, locationCode: number | null) => `${keywordId}:${locationCode ?? ""}`;

const TOP = 10;

/** Rule left-top-10: keywords in the top 10 at their previous confirmed check that this check confirmed below it. */
export function leftTop10(rows: RankRow[], dayLabel: (date: string) => string): Detected {
  const findings: Finding[] = [];
  const fine: string[] = [];
  for (const r of rows) {
    if (r.notChecked) continue;
    const key = rankKey(r.keywordId, r.locationCode);
    if (r.position != null && r.position <= TOP) {
      fine.push(key);
      continue;
    }
    const before = r.previous?.position;
    if (before == null || before > TOP) continue;
    const now = r.position == null ? `not in the top ${r.depth}` : `position ${r.position}`;
    findings.push({
      key,
      title: `“${r.keyword}” left the top 10`,
      detail: `Position ${before} on ${dayLabel(r.previous!.date)}, ${now} now.`,
      screen: `/rank/${r.keywordId}`,
    });
  }
  return { findings, fine };
}
