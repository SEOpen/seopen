import { and, between, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { gscBreakdown } from "@/db/schema";
import { inScope, type ProjectScope } from "@/lib/workspace";
import { googleApis } from "./apis";
import { LIKELY_BOT_PATTERN } from "./bot-queries";
import type { Totals } from "./data";
import type { GscDimension, GscFilter, GscRow } from "./types";
import type { DateRange } from "./windowing";

/**
 * Search Console numbers for one country. The sync stores countries only as daily site totals
 * (`gsc_breakdown`), not per search or page, so totals come from there and rows split by search,
 * page or device are read from Search Console when asked, with its country filter. Nothing is stored.
 * A live read has no per-day row cap, so it can list searches the stored tables don't have.
 */

/** Search Console's country codes are lowercase ISO 3166 alpha-3, as stored: "usa", "esp", "deu". */
export function countryCode(raw: string): string | null {
  const code = raw.trim().toLowerCase();
  return /^[a-z]{3}$/.test(code) ? code : null;
}

/** The country's share of the site's totals over the period, from the stored daily country figures. */
export async function gscCountryTotals(scope: ProjectScope, range: DateRange, country: string): Promise<Totals> {
  const [r] = await db
    .select({
      clicks: sql<number>`coalesce(sum(${gscBreakdown.clicks}), 0)::int`,
      impressions: sql<number>`coalesce(sum(${gscBreakdown.impressions}), 0)::int`,
      position: sql<number>`coalesce(sum(${gscBreakdown.position} * ${gscBreakdown.impressions}) / nullif(sum(${gscBreakdown.impressions}), 0), 0)::float`,
    })
    .from(gscBreakdown)
    .where(and(inScope(gscBreakdown, scope), eq(gscBreakdown.kind, "country"), eq(gscBreakdown.key, country), between(gscBreakdown.date, range.start, range.end)));
  const t = r ?? { clicks: 0, impressions: 0, position: 0 };
  return { ...t, ctr: t.impressions ? t.clicks / t.impressions : 0 };
}

export interface LiveRead {
  property: string;
  workspaceId: number;
  country: string;
  dimensions: Exclude<GscDimension, "date" | "country">[];
  /** Matches queries or pages containing this text, as `contains` does on stored rows. */
  contains?: { dimension: "query" | "page"; text: string };
  maxRows: number;
}

/** One period's rows for the country, most clicks first, summed over the period by Search Console. */
export async function gscCountryRows(read: LiveRead, range: DateRange): Promise<GscRow[]> {
  const filters: GscFilter[] = [{ dimension: "country", operator: "equals", expression: read.country }];
  if (read.contains?.text) filters.push({ dimension: read.contains.dimension, operator: "contains", expression: read.contains.text });
  const api = await googleApis(read.workspaceId);
  const res = await api.gsc.query(read.property, { startDate: range.start, endDate: range.end, dimensions: read.dimensions, filters, maxRows: read.maxRows });
  return res.rows;
}

/** What searches that look like rank checks (`isLikelyBotQuery`) added to the country's totals over the period, read with the same rule as a Search Console filter. */
export async function gscCountryLikelyBotTotals(read: Pick<LiveRead, "property" | "workspaceId" | "country">, range: DateRange): Promise<{ clicks: number; impressions: number; weighted: number }> {
  const api = await googleApis(read.workspaceId);
  const filters: GscFilter[] = [
    { dimension: "country", operator: "equals", expression: read.country },
    { dimension: "query", operator: "includingRegex", expression: LIKELY_BOT_PATTERN },
  ];
  const res = await api.gsc.query(read.property, { startDate: range.start, endDate: range.end, dimensions: ["query"], filters });
  return res.rows.reduce((t, r) => ({ clicks: t.clicks + r.clicks, impressions: t.impressions + r.impressions, weighted: t.weighted + r.position * r.impressions }), { clicks: 0, impressions: 0, weighted: 0 });
}
