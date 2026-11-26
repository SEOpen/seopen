import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema/core";
import { localBusinesses, localChecks, localKeywords } from "@/db/schema/local";
import { creditsFor, showsDollarCosts } from "@/lib/billing/gates";
import { loadBillingWorkspace, projectActionRefusal } from "@/lib/billing/workspace";
import { dfsPost, peekCache, SpendRefusedError, TTL } from "@/lib/dataforseo/client";
import { enqueue } from "@/lib/jobs/boss";
import { OpError, plural, refused, type OpOptions } from "@/lib/ops";
import type { ProjectScope } from "@/lib/workspace";
import { rules } from "@/plan-policy/rules";
import { DEFAULT_GRID_SIZE, DEFAULT_RADIUS_MILES, DEPTH, estimateCheckUsd, gridLabel, isGridSize, isRadius, SEARCH_PRICE_USD } from "./grid";
import { candidateKey, MAX_KEYWORDS_PER_BUSINESS, normalizeKeyword, parseCandidates, type Candidate } from "./parse";
import { createCheck, getBusiness } from "./tracker";
import type { MapsResult } from "./types";

/**
 * Local SEO changes shared by the Server Actions and the MCP server (see `src/lib/ops`). Local SEO
 * spends research credits, so its paid steps quote credits (and dollars where the workspace sees
 * them) before they run.
 */

const MAPS_SEARCH = "serp/google/maps/live/advanced";

const clean = (v: string | null | undefined, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

async function searchTasks(scope: ProjectScope, name: string, city: string) {
  const [project] = await db
    .select({ locationCode: projects.locationCode, languageCode: projects.languageCode })
    .from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId)));
  return [{ keyword: `${name} ${city}`, location_code: project.locationCode, language_code: project.languageCode, device: "desktop", depth: DEPTH }];
}

/**
 * One Live Google Maps search for "<name> <city>". Cached for a day per workspace, so the search
 * that adds the picked listing (and a second look) costs nothing.
 */
async function searchMaps(scope: ProjectScope, name: string, city: string): Promise<Candidate[]> {
  const res = await dfsPost<MapsResult>(MAPS_SEARCH, await searchTasks(scope, name, city), {
    workspaceId: scope.workspaceId,
    module: "local",
    projectId: scope.projectId,
    ttlSeconds: TTL.day,
    estimateUsd: SEARCH_PRICE_USD,
  });
  const task = res.tasks?.[0];
  if (task && task.status_code !== 20000 && task.status_code !== 40102) throw new Error(`Google Maps search failed (${task.status_code} ${task.status_message})`);
  return parseCandidates(task?.result?.[0]);
}

/** A paid Local SEO step's price: credits for everyone, dollars only where the workspace sees them. */
export interface LocalPrice {
  credits: number;
  usd: number | null;
}

async function priceOf(scope: ProjectScope, usd: number): Promise<LocalPrice> {
  return { credits: creditsFor(usd), usd: showsDollarCosts(await loadBillingWorkspace(scope.workspaceId)) ? usd : null };
}

/** A business id that isn't one of this project's: deleted, another project's, or mistyped. */
const NO_BUSINESS = "No listing with that id in this project.";

/** Step 2 without step 1's search to read from: never run, or more than a day old. */
export const SEARCH_NOT_SAVED = "That search isn't saved: it was never run, or it ran more than a day ago. Search for the business again with the same name and city, then add the listing.";

function spendMessage(e: unknown): never {
  if (e instanceof SpendRefusedError) throw new OpError(e.message, e.refusal);
  throw e;
}

export interface FoundListings {
  dryRun: boolean;
  name: string;
  city: string;
  /** True when this workspace searched the same thing in the last day: the search is free. */
  cached: boolean;
  price: LocalPrice;
  /** Empty on a dry run. Each has a `listing` key to pass when adding it. */
  candidates: (Candidate & { listing: string })[];
  message: string;
}

/** Step 1 of adding a business: look it up on Google Maps and offer the listings found. */
export async function findListingsOp(scope: ProjectScope, input: { name: string; city: string }, opts: OpOptions = {}): Promise<FoundListings> {
  const name = clean(input.name);
  const city = clean(input.city);
  if (!name || !city) throw new OpError("Enter the business name and its city.");
  const refusal = await projectActionRefusal(scope, { paid: true, research: true, quiet: opts.dryRun });
  if (refusal) throw refused(refusal);
  const cached = (await peekCache(scope.workspaceId, "POST", MAPS_SEARCH, await searchTasks(scope, name, city))) !== null;
  const price = cached ? { credits: 0, usd: null } : await priceOf(scope, SEARCH_PRICE_USD);
  if (opts.dryRun) {
    const cost = cached ? "free (searched in the last day)" : `≈ ${rules.creditsText(price.credits)}`;
    return { dryRun: true, name, city, cached, price, candidates: [], message: `Would search Google Maps for “${name}” in ${city}: ${cost}.` };
  }
  const candidates = await searchMaps(scope, name, city).catch(spendMessage);
  const message = candidates.length
    ? `Found ${plural(candidates.length, "listing")} for “${name}” in ${city}.`
    : `Google Maps found no listing for “${name}” in ${city}. Check the spelling, or try the name exactly as it appears on Maps.`;
  return { dryRun: false, name, city, cached, price, candidates: candidates.map((c) => ({ ...c, listing: candidateKey(c) })), message };
}

export interface AddedBusiness {
  dryRun: boolean;
  /** Null on a dry run. */
  businessId: number | null;
  /** The listing was already tracked on this project; nothing changed. */
  existing: boolean;
  title: string;
  message: string;
}

/**
 * Step 2: track the listing picked from step 1's results. The search is repeated (a free cache hit
 * within a day) and the listing is taken from DataForSEO's answer, so the caller can't supply its
 * own coordinates or ids.
 *
 * `savedSearchOnly` is for a caller that takes no price for this step (the MCP tool): the listing
 * comes from step 1's saved search or not at all, so adding never buys a search. Without it a search
 * older than a day is bought again, which the app's own form allows.
 */
export async function addBusinessOp(
  scope: ProjectScope,
  input: { name: string; city: string; listing: string; scheduled?: boolean; gridSize?: number; radiusMiles?: number },
  opts: OpOptions & { savedSearchOnly?: boolean } = {},
): Promise<AddedBusiness> {
  const name = clean(input.name);
  const city = clean(input.city);
  // Paid like step 1: the search is usually a free cache hit, but one older than a day is bought again.
  const refusal = await projectActionRefusal(scope, { paid: true, research: true, quiet: opts.dryRun });
  if (refusal) throw refused(refusal);
  const gridSize = input.gridSize ?? DEFAULT_GRID_SIZE;
  const radiusMiles = input.radiusMiles ?? DEFAULT_RADIUS_MILES;
  if (!isGridSize(gridSize) || !isRadius(radiusMiles)) throw new OpError("The grid is 3, 5 or 7 points across, and the radius 1, 3, 5 or 10 miles.");
  const tasks = await searchTasks(scope, name, city);
  // A dry run only looks in the cache, so it never spends; step 1 put the search there.
  const saved = opts.dryRun || opts.savedSearchOnly ? await peekCache<MapsResult>(scope.workspaceId, "POST", MAPS_SEARCH, tasks) : null;
  // The one read decides: a search that expires right after it is still used, never bought again.
  if (opts.savedSearchOnly && !opts.dryRun && !saved) throw new OpError(SEARCH_NOT_SAVED);
  const candidates = opts.dryRun || opts.savedSearchOnly ? parseCandidates(saved?.response.tasks?.[0]?.result?.[0]) : await searchMaps(scope, name, city).catch(spendMessage);
  const picked = candidates.find((c) => candidateKey(c) === input.listing);
  if (!picked) throw new OpError("Pick one of the listings the search found (its `listing` key), searching again with the same name and city first if needed.");
  const [existing] = await db
    .select({ id: localBusinesses.id })
    .from(localBusinesses)
    .where(
      and(
        eq(localBusinesses.workspaceId, scope.workspaceId),
        eq(localBusinesses.projectId, scope.projectId),
        picked.cid ? eq(localBusinesses.cid, picked.cid) : eq(localBusinesses.placeId, picked.placeId!),
      ),
    );
  if (existing) return { dryRun: !!opts.dryRun, businessId: existing.id, existing: true, title: picked.title, message: `${picked.title} is already tracked.` };
  const scheduled = input.scheduled ?? true;
  const what = `${picked.title} on a ${gridLabel(gridSize, radiusMiles)} grid${scheduled ? ", checked weekly" : ""}`;
  if (opts.dryRun) return { dryRun: true, businessId: null, existing: false, title: picked.title, message: `Would track ${what}.` };
  const [row] = await db
    .insert(localBusinesses)
    .values({
      ...scope,
      query: name,
      city,
      title: picked.title,
      address: picked.address,
      category: picked.category,
      domain: picked.domain,
      phone: picked.phone,
      rating: picked.rating,
      votes: picked.votes,
      cid: picked.cid,
      placeId: picked.placeId,
      lat: picked.lat,
      lng: picked.lng,
      gridSize,
      radiusMiles,
      scheduled,
    })
    .returning({ id: localBusinesses.id });
  return { dryRun: false, businessId: row.id, existing: false, title: picked.title, message: `Tracking ${what}. Add keywords next.` };
}

export interface AddedLocalKeywords {
  dryRun: boolean;
  added: string[];
  already: number;
  overLimit: number;
  message: string;
}

/** Adds keywords to a business: trimmed, lowercased and deduped, against what's already there. */
export async function addLocalKeywordsOp(scope: ProjectScope, businessId: number, words: string[], opts: OpOptions = {}): Promise<AddedLocalKeywords> {
  const business = await getBusiness(scope, businessId);
  if (!business) throw new OpError(NO_BUSINESS);
  const locked = await projectActionRefusal(scope);
  if (locked) throw refused(locked);
  const unique = [...new Set(words.map(normalizeKeyword).filter(Boolean))];
  if (!unique.length) throw new OpError("Type at least one keyword.");
  const existing = await db
    .select({ keyword: localKeywords.keyword })
    .from(localKeywords)
    .where(and(eq(localKeywords.workspaceId, scope.workspaceId), eq(localKeywords.businessId, business.id)));
  const have = new Set(existing.map((e) => e.keyword));
  const fresh = unique.filter((w) => !have.has(w));
  const room = Math.max(0, MAX_KEYWORDS_PER_BUSINESS - have.size);
  const adding = fresh.slice(0, room);
  if (fresh.length && !adding.length) throw new OpError(`A business can have ${MAX_KEYWORDS_PER_BUSINESS} keywords. Remove one to add another.`);
  if (adding.length && !opts.dryRun) {
    await db
      .insert(localKeywords)
      .values(adding.map((keyword) => ({ workspaceId: scope.workspaceId, businessId: business.id, keyword })))
      .onConflictDoNothing();
  }
  const already = unique.length - fresh.length;
  const overLimit = fresh.length - adding.length;
  const parts = [`${opts.dryRun ? "Would add" : "Added"} ${plural(adding.length, "keyword")}`];
  if (already) parts.push(`${already} already tracked`);
  if (overLimit) parts.push(`${overLimit} over the limit of ${MAX_KEYWORDS_PER_BUSINESS}`);
  return { dryRun: !!opts.dryRun, added: adding, already, overLimit, message: `${parts.join(" · ")}.` };
}

export const ALREADY_RUNNING = "A check is already running for this business. Results appear as they land; try again once it finishes.";

export interface StartedLocalCheck {
  dryRun: boolean;
  /** Null on a dry run. */
  checkId: number | null;
  keywords: number;
  points: number;
  price: LocalPrice;
  message: string;
}

/** "Check now": every keyword at every point of the business's grid. One check at a time per business. */
export async function startLocalCheckOp(scope: ProjectScope, businessId: number, opts: OpOptions = {}): Promise<StartedLocalCheck> {
  const business = await getBusiness(scope, businessId);
  if (!business) throw new OpError(NO_BUSINESS);
  const refusal = await projectActionRefusal(scope, { paid: true, research: true, quiet: opts.dryRun });
  if (refusal) throw refused(refusal);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(localKeywords)
    .where(and(eq(localKeywords.workspaceId, scope.workspaceId), eq(localKeywords.businessId, business.id)));
  if (!n) throw new OpError("Add a keyword first.");
  const points = business.gridSize * business.gridSize;
  const price = await priceOf(scope, estimateCheckUsd(business.gridSize, n));
  const what = `${plural(n, "keyword")} at ${points} points`;
  if (opts.dryRun) return { dryRun: true, checkId: null, keywords: n, points, price, message: `Would check ${what}: ≈ ${rules.creditsText(price.credits)}.` };
  const check = await createCheck(scope, business, "manual");
  if (!check) throw new OpError(ALREADY_RUNNING);
  try {
    await enqueue("local.check", { ...scope, checkId: check.id });
  } catch (e) {
    // Free the slot so the next click can try again.
    await db
      .update(localChecks)
      .set({ status: "failed", error: "Could not queue the check", finishedAt: new Date() })
      .where(and(eq(localChecks.id, check.id), eq(localChecks.workspaceId, scope.workspaceId)));
    throw e;
  }
  return { dryRun: false, checkId: check.id, keywords: n, points, price, message: `Started a check of ${what}. Results appear as they land.` };
}
