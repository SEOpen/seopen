import { ISSUES, type Severity } from "./taxonomy";

/**
 * Health score, 0–100.
 *
 * 1. Every crawled HTML page starts at 100 and loses points for each distinct issue it has:
 *    25 per error, 8 per warning, 2 per notice (never below 0).
 * 2. The site score is the average page score.
 * 3. Site-wide issues (certificate, sitemap, robots.txt, host) then subtract 5 per error,
 *    2 per warning and 0.5 per notice, at most 20 points in total.
 *
 * So a site where every page is clean scores 100, and one where every page has a single error
 * scores 75. Notices barely move it; they're things worth a look, not faults.
 */
export const PAGE_PENALTY: Record<Severity, number> = { error: 25, warning: 8, notice: 2 };
export const SITE_PENALTY: Record<Severity, number> = { error: 5, warning: 2, notice: 0.5 };
export const MAX_SITE_PENALTY = 20;

export interface ScoredIssue {
  code: string;
  url: string;
}

export interface ScoreResult {
  score: number;
  errors: number;
  warnings: number;
  notices: number;
  pagesWithIssues: number;
}

/**
 * @param pageUrls URLs of the crawled HTML pages (the denominator).
 * @param issues every (code, url) issue row; site-level issues use any URL.
 */
export function healthScore(pageUrls: readonly string[], issues: readonly ScoredIssue[]): ScoreResult {
  const perPage = new Map<string, Set<string>>();
  const siteCodes = new Set<string>();
  const counts: Record<Severity, number> = { error: 0, warning: 0, notice: 0 };
  const affected = new Set<string>();

  for (const i of issues) {
    const def = ISSUES[i.code];
    if (!def) continue;
    counts[def.severity]++;
    affected.add(i.url);
    if (def.site) {
      siteCodes.add(i.code);
      continue;
    }
    let set = perPage.get(i.url);
    if (!set) perPage.set(i.url, (set = new Set()));
    set.add(i.code);
  }

  let total = 0;
  for (const url of pageUrls) {
    let page = 100;
    for (const code of perPage.get(url) ?? []) page -= PAGE_PENALTY[ISSUES[code].severity];
    total += Math.max(page, 0);
  }
  const pageAvg = pageUrls.length ? total / pageUrls.length : 100;

  let sitePenalty = 0;
  for (const code of siteCodes) sitePenalty += SITE_PENALTY[ISSUES[code].severity];
  const score = Math.max(0, Math.min(100, pageAvg - Math.min(sitePenalty, MAX_SITE_PENALTY)));

  return {
    score: Math.round(score * 10) / 10,
    errors: counts.error,
    warnings: counts.warning,
    notices: counts.notice,
    pagesWithIssues: affected.size,
  };
}

/**
 * Errors, warnings and notices from a crawl's issue rows, each row one check failing on one URL, by
 * today's taxonomy. A crawl stores the counts it had when it was imported, so after a check changes
 * severity those columns disagree with the crawl's own rows; the pages read these instead.
 */
export function severityCounts(rows: readonly { code: string; n: number }[]): { errors: number; warnings: number; notices: number } {
  const counts: Record<Severity, number> = { error: 0, warning: 0, notice: 0 };
  for (const r of rows) {
    const def = ISSUES[r.code];
    if (def) counts[def.severity] += r.n;
  }
  return { errors: counts.error, warnings: counts.warning, notices: counts.notice };
}

/** The move between two scores as the app prints them: whole numbers, so 79.6 and 80.4 both read 80 and nothing moved. */
export const scorePoints = (now: number, before: number) => Math.round(now) - Math.round(before);

/** Word for a score band, used next to the score. */
export function scoreBand(score: number | null | undefined): { label: string; tone: "good" | "warn" | "bad" } {
  if (score == null) return { label: "No data", tone: "warn" };
  if (score >= 90) return { label: "Healthy", tone: "good" };
  if (score >= 70) return { label: "Needs work", tone: "warn" };
  return { label: "Poor", tone: "bad" };
}
