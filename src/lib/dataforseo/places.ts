import { and, asc, eq, inArray, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { dfsPlaces } from "@/db/schema/core";
import { dfsGet, TTL } from "./client";
import { marketIso } from "./locations";
import { CITY_TYPES, cityPattern, placeKey, placeName, type Place } from "./place-names";

interface LocationRow {
  location_code: number;
  location_name: string;
  location_type: string;
}

const LIST_ROWS = 20;
const INSERT_BATCH = 1000;

/** Countries being fetched right now, so a burst of searches makes one call. */
const filling = new Map<string, Promise<void>>();

async function fill(iso: string) {
  // Free. About 10 MB for the US, so it's never cached as a response: only the cities are kept.
  const res = await dfsGet<LocationRow>(`serp/google/locations/${iso}`, { module: "core", free: true, ttlSeconds: 0 });
  const rows = (res.tasks?.[0]?.result ?? []).filter((l) => CITY_TYPES.has(l.location_type));
  if (!rows.length) throw new Error(`No cities in DataForSEO's list for ${iso}`);
  const now = new Date();
  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    await db
      .insert(dfsPlaces)
      .values(rows.slice(i, i + INSERT_BATCH).map((l) => ({ code: l.location_code, name: placeName(l.location_name), countryIso: iso, updatedAt: now })))
      .onConflictDoUpdate({ target: dfsPlaces.code, set: { name: sql`excluded.name`, countryIso: sql`excluded.country_iso`, updatedAt: now } });
  }
}

/** Makes sure a country's cities are stored and under 30 days old. A failed refresh keeps the list we have. */
export async function ensurePlaces(iso: string): Promise<void> {
  const [row] = await db.select({ at: max(dfsPlaces.updatedAt) }).from(dfsPlaces).where(eq(dfsPlaces.countryIso, iso));
  const age = row?.at ? Date.now() - row.at.getTime() : Infinity;
  if (age < TTL.month * 1000) return;
  let job = filling.get(iso);
  if (!job) {
    job = fill(iso).finally(() => filling.delete(iso));
    filling.set(iso, job);
  }
  try {
    await job;
  } catch (e) {
    if (age === Infinity) throw e;
    console.error(`[places] refreshing ${iso}`, e);
  }
}

/** Cities of a market whose name starts with what was typed. Empty for a market without a list. */
export async function searchCities(locationCode: number, query: string): Promise<Place[]> {
  const iso = marketIso(locationCode);
  const pattern = iso && cityPattern(query, iso);
  if (!iso || !pattern) return [];
  await ensurePlaces(iso);
  return db
    .select({ code: dfsPlaces.code, name: dfsPlaces.name })
    .from(dfsPlaces)
    .where(and(eq(dfsPlaces.countryIso, iso), sql`lower(${dfsPlaces.name}) like ${pattern}`))
    .orderBy(sql`length(${dfsPlaces.name})`, asc(dfsPlaces.name))
    .limit(LIST_ROWS);
}

/** Cities in a market with exactly this name, whatever their region. */
export async function citiesNamed(locationCode: number, city: string): Promise<Place[]> {
  const iso = marketIso(locationCode);
  if (!iso) return [];
  await ensurePlaces(iso);
  const name = city.trim().toLowerCase();
  return db
    .select({ code: dfsPlaces.code, name: dfsPlaces.name })
    .from(dfsPlaces)
    .where(and(eq(dfsPlaces.countryIso, iso), sql`lower(split_part(${dfsPlaces.name}, ',', 1)) = ${name}`))
    .orderBy(asc(dfsPlaces.name))
    .limit(LIST_ROWS);
}

/**
 * Cities of a market with any of these names, whatever their spelling of "St" or "Fort" and their
 * region. Asks once for all of them. Empty for a market without a list, or when the list can't be
 * fetched, so a caller can go on without it.
 */
export async function placesNamed(locationCode: number, names: string[]): Promise<Place[]> {
  const iso = marketIso(locationCode);
  if (!iso || !names.length) return [];
  try {
    await ensurePlaces(iso);
  } catch (e) {
    console.error(`[places] no list for ${iso}`, e);
    return [];
  }
  const keys = [...new Set(names.map(placeKey))];
  const key = sql`regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(split_part(${dfsPlaces.name}, ',', 1)), '\\.', '', 'g'), '\\msaint\\M', 'st', 'g'), '\\mfort\\M', 'ft', 'g'), '\\mmount\\M', 'mt', 'g')`;
  return db
    .select({ code: dfsPlaces.code, name: dfsPlaces.name })
    .from(dfsPlaces)
    .where(and(eq(dfsPlaces.countryIso, iso), inArray(key, keys)))
    .orderBy(asc(dfsPlaces.name));
}

/** A city by its code, only if it's in that market. Never trust a code from a form or a URL without this. */
export async function cityInMarket(code: number, locationCode: number): Promise<Place | null> {
  const iso = marketIso(locationCode);
  if (!iso || !Number.isInteger(code) || code <= 0) return null;
  await ensurePlaces(iso);
  const [row] = await db
    .select({ code: dfsPlaces.code, name: dfsPlaces.name })
    .from(dfsPlaces)
    .where(and(eq(dfsPlaces.code, code), eq(dfsPlaces.countryIso, iso)));
  return row ?? null;
}

/** Stored names for these location codes. A country isn't in here: use `locationName`. */
export async function placeNames(codes: number[]): Promise<Map<number, string>> {
  if (!codes.length) return new Map();
  const rows = await db.select({ code: dfsPlaces.code, name: dfsPlaces.name }).from(dfsPlaces).where(inArray(dfsPlaces.code, codes));
  return new Map(rows.map((r) => [r.code, r.name]));
}
