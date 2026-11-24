// Parsing for the local module: keyword input, task tags and Google Maps results. Pure, so it is unit tested.
import type { LocalListing } from "@/db/schema/local";
import type { MapsItem, MapsResult } from "./types";

export const MAX_KEYWORDS_PER_BUSINESS = 20;
const MAX_KEYWORD_LENGTH = 120;

/** One keyword as stored: trimmed, inner whitespace collapsed, lowercased. Empty when nothing is left. */
export function normalizeKeyword(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().toLowerCase().slice(0, MAX_KEYWORD_LENGTH).trim();
}

/** Keywords from pasted text, one per line or comma separated: normalized, empties dropped, deduped in order. */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>();
  for (const part of text.split(/[\n,;]+/)) {
    const k = normalizeKeyword(part);
    if (k) seen.add(k);
  }
  return [...seen];
}

/** Task tag "local:<checkId>:<pointId>", so a result can be matched to its point. */
export function makeTag(checkId: number, pointId: number): string {
  return `local:${checkId}:${pointId}`;
}

export function parseTag(tag: string | null | undefined): { checkId: number; pointId: number } | null {
  const m = /^local:(\d+):(\d+)$/.exec(tag ?? "");
  return m ? { checkId: Number(m[1]), pointId: Number(m[2]) } : null;
}

/** The ids we match a listing on. */
export interface ListingIds {
  cid: string | null;
  placeId: string | null;
}

/** True when a Maps item is this listing: same cid or same place_id. Names are never compared. */
export function isSameListing(item: Pick<MapsItem, "cid" | "place_id">, ours: ListingIds): boolean {
  if (ours.cid && item.cid && String(item.cid) === ours.cid) return true;
  if (ours.placeId && item.place_id && item.place_id === ours.placeId) return true;
  return false;
}

/** Organic Maps listings (not ads), in rank order. */
function listings(result: MapsResult | null | undefined): MapsItem[] {
  return (result?.items ?? [])
    .filter((it) => it.type === "maps_search" && it.title)
    .sort((a, b) => (a.rank_group ?? 0) - (b.rank_group ?? 0));
}

function compact(it: MapsItem, i: number): LocalListing {
  return {
    r: it.rank_group ?? i + 1,
    t: it.title ?? "",
    cid: it.cid != null ? String(it.cid) : null,
    pid: it.place_id ?? null,
    cat: it.category ?? null,
    addr: it.address ?? null,
    d: it.domain ?? null,
    rating: it.rating?.value ?? null,
    votes: it.rating?.votes_count ?? null,
  };
}

/** What one grid point's task came back with. */
export type PointOutcome =
  | { status: "done"; rank: number | null; items: LocalListing[] }
  | { status: "failed"; error: string }
  | { status: "wait" };

/** Not ready yet: ask again later. */
const NOT_READY = new Set([40601, 40602]);

/**
 * Turns a task_get answer into a point result. A response that is an error, or a successful one
 * with no listings at all, is Failed: Maps telling us nothing is not the same as Maps listing other
 * businesses, so it never counts as "not found". Only a point with listings, none of them ours,
 * is Not found (done, rank null).
 */
export function pointOutcome(
  task: { status_code?: number; status_message?: string; result?: MapsResult[] | null } | null | undefined,
  ours: ListingIds,
  depth = 20,
): PointOutcome {
  const code = task?.status_code ?? 0;
  if (NOT_READY.has(code)) return { status: "wait" };
  if (code !== 20000) return { status: "failed", error: code ? `${code} ${task?.status_message ?? ""}`.trim() : "No answer from DataForSEO" };
  const items = listings(task?.result?.[0]);
  if (!items.length) return { status: "failed", error: "Google Maps returned no listings here" };
  const top = items.slice(0, depth).map(compact);
  const mine = items.find((it) => isSameListing(it, ours));
  const rank = mine ? (mine.rank_group ?? items.indexOf(mine) + 1) : null;
  return { status: "done", rank: rank != null && rank <= depth ? rank : null, items: top };
}

/** A listing offered when the user looks a business up. */
export interface Candidate {
  title: string;
  address: string | null;
  category: string | null;
  domain: string | null;
  phone: string | null;
  rating: number | null;
  votes: number | null;
  cid: string | null;
  placeId: string | null;
  lat: number;
  lng: number;
}

/** The key a candidate is picked by in the form: its cid, else its place_id. */
export function candidateKey(c: Pick<Candidate, "cid" | "placeId">): string {
  return c.cid ? `cid:${c.cid}` : `pid:${c.placeId}`;
}

/** Listings from a Maps search that can be tracked: they need coordinates and a cid or place_id. */
export function parseCandidates(result: MapsResult | null | undefined, limit = 8): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const it of listings(result)) {
    const cid = it.cid != null ? String(it.cid) : null;
    const placeId = it.place_id ?? null;
    if (!cid && !placeId) continue;
    if (typeof it.latitude !== "number" || typeof it.longitude !== "number") continue;
    const c: Candidate = {
      title: it.title!,
      address: it.address ?? null,
      category: it.category ?? null,
      domain: it.domain ?? null,
      phone: it.phone ?? null,
      rating: it.rating?.value ?? null,
      votes: it.rating?.votes_count ?? null,
      cid,
      placeId,
      lat: it.latitude,
      lng: it.longitude,
    };
    const key = candidateKey(c);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}
