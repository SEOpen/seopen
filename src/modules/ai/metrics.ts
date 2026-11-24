/** Visibility and share-of-voice math over stored answers. Pure functions, no I/O. */
import type { AiBrandMention } from "@/db/schema/ai";

export interface AnswerRow {
  promptId: number;
  platform: string;
  mentioned: boolean | null;
  cited: boolean | null;
  position: number | null;
  mentions: AiBrandMention[] | null;
  /** Run date (ISO) or run id: used to pick the latest answer per prompt × platform. */
  at: string;
  /** The answer failed, so whether it names you is unknown. */
  failed?: boolean;
}

/** Keep the newest answer for each prompt × platform. */
export function latestPerPair<T extends Pick<AnswerRow, "promptId" | "platform" | "at">>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.promptId}:${r.platform}`;
    const cur = best.get(k);
    if (!cur || r.at > cur.at) best.set(k, r);
  }
  return [...best.values()];
}

/**
 * The answers the numbers count: the newest finished answer for each prompt × platform, left out when it
 * failed. A failed answer is unknown, not a miss, and the pair's older answer is from an earlier run, so
 * it can't stand in for this one either.
 */
export function answeredPerPair<T extends Pick<AnswerRow, "promptId" | "platform" | "at" | "failed">>(rows: T[]): T[] {
  return latestPerPair(rows).filter((r) => !r.failed);
}

/**
 * Leaves out the runs where every answer failed. Such a run says nothing about any pair, so it neither
 * counts nor hides the answers before it. The run's own failure is said where the run is.
 */
export function withoutFailedRuns<T extends { runId: number; failed?: boolean }>(rows: T[]): T[] {
  const answered = new Set(rows.filter((r) => !r.failed).map((r) => r.runId));
  return rows.filter((r) => answered.has(r.runId));
}

export interface Visibility {
  /** Answers checked. */
  total: number;
  mentioned: number;
  cited: number;
  /** Share of answers that mention us, 0–1. Null with no answers. */
  score: number | null;
  citedRate: number | null;
  /** Mean position among tracked brands, over answers that mention us. */
  avgPosition: number | null;
}

/** Visibility = share of answers (prompt × platform) where our brand is mentioned. */
export function visibility(rows: AnswerRow[]): Visibility {
  const total = rows.length;
  const mentioned = rows.filter((r) => r.mentioned).length;
  const cited = rows.filter((r) => r.cited).length;
  const positions = rows.filter((r) => r.mentioned && r.position != null).map((r) => r.position!);
  return {
    total,
    mentioned,
    cited,
    score: total ? mentioned / total : null,
    citedRate: total ? cited / total : null,
    avgPosition: positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : null,
  };
}

/**
 * Cited answers as they stood after each of the last `limit` runs, oldest first: the answers counted
 * (`answeredPerPair`) up to that run, so the last point is the current number.
 */
export function citedByRun<T extends AnswerRow & { runId: number }>(rows: T[], limit = 30): { at: string; cited: number }[] {
  const runs = [...new Set(rows.map((r) => r.at))].sort().slice(-limit);
  return runs.map((at) => ({ at: at.split("#")[0], cited: visibility(answeredPerPair(rows.filter((r) => r.at <= at))).cited }));
}

/** Visibility per platform, in the given platform order (platforms with no answers are skipped). */
export function visibilityByPlatform(rows: AnswerRow[], platforms: string[]): (Visibility & { platform: string })[] {
  return platforms
    .map((platform) => ({ platform, ...visibility(rows.filter((r) => r.platform === platform)) }))
    .filter((v) => v.total > 0);
}

/**
 * How many prompt × platform pairs are failing, per platform: the pair's newest finished answer failed.
 * `answeredPerPair` leaves these out of the numbers, so they're said beside them. One that was answered
 * later has stopped failing.
 */
export function failedPerPlatform(rows: (Pick<AnswerRow, "promptId" | "platform" | "at"> & { failed: boolean })[]): Record<string, number> {
  const failed: Record<string, number> = {};
  for (const r of latestPerPair(rows)) if (r.failed) failed[r.platform] = (failed[r.platform] ?? 0) + 1;
  return failed;
}

/**
 * `byPlatform` with the platforms that have failures and no answers put back in their place, at no
 * answers: otherwise a platform failing every time just goes missing from the list.
 */
export function withFailedPlatforms(byPlatform: (Visibility & { platform: string })[], failed: Record<string, number>, platforms: string[]): (Visibility & { platform: string })[] {
  return platforms.flatMap((platform) => {
    const row = byPlatform.find((p) => p.platform === platform);
    if (row) return [row];
    return failed[platform] ? [{ platform, ...visibility([]) }] : [];
  });
}

export interface BrandShare {
  domain: string;
  own: boolean;
  /** Answers that mention the brand. */
  answers: number;
  /** Answers that cite the brand's domain. */
  cited: number;
  /** Share of voice: this brand's mentioning answers / all tracked brands' mentioning answers. */
  sov: number | null;
  /** Mention rate: answers mentioning this brand / all answers. */
  rate: number | null;
}

/**
 * Share of voice across tracked brands. Each answer counts once per brand it mentions, so
 * an answer naming us and two competitors adds 1 to each. Brands are those in `domains`
 * (us first), so a brand with zero mentions still shows up.
 */
export function shareOfVoice(rows: AnswerRow[], domains: { domain: string; own: boolean }[]): BrandShare[] {
  const answers = new Map<string, number>();
  const cited = new Map<string, number>();
  for (const r of rows) {
    for (const m of r.mentions ?? []) {
      if (m.count > 0) answers.set(m.domain, (answers.get(m.domain) ?? 0) + 1);
      if (m.cited) cited.set(m.domain, (cited.get(m.domain) ?? 0) + 1);
    }
  }
  const tracked = domains.map((d) => d.domain);
  const totalMentions = tracked.reduce((n, d) => n + (answers.get(d) ?? 0), 0);
  return domains.map((d) => {
    const a = answers.get(d.domain) ?? 0;
    return {
      domain: d.domain,
      own: d.own,
      answers: a,
      cited: cited.get(d.domain) ?? 0,
      sov: totalMentions ? a / totalMentions : null,
      rate: rows.length ? a / rows.length : null,
    };
  });
}

/** Change between two ratios in percentage points, rounded to 0.1. Null when either is missing. */
export function deltaPoints(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null) return null;
  return Math.round((current - previous) * 1000) / 10;
}
