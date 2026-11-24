"use server";

import { requireSession } from "@/lib/auth/session";
import { DataForSEOError } from "@/lib/dataforseo/client";
import { plainFailureLine } from "@/lib/dataforseo/failure-copy";
import { LOCATIONS, marketIso } from "@/lib/dataforseo/locations";
import { citiesNamed, searchCities } from "@/lib/dataforseo/places";
import { listingCity, matchListing, type Place } from "@/lib/dataforseo/place-names";
import { requireProject } from "@/lib/projects";
import { listBusinesses } from "@/modules/local/queries";

export type CitySearch = { cities: Place[]; error?: string };

/**
 * The city box: cities of one of our markets. The first search of a country loads its list from DataForSEO,
 * which takes a few seconds and is free, but needs the DataForSEO login: without it the box says so.
 */
export async function findCities(locationCode: number, query: string): Promise<CitySearch> {
  await requireSession();
  if (!LOCATIONS.some((l) => l.code === locationCode)) return { cities: [] };
  try {
    return { cities: await searchCities(locationCode, String(query).slice(0, 80)) };
  } catch (e) {
    console.error("[places] search", e);
    return { cities: [], error: e instanceof DataForSEOError ? plainFailureLine(e) : "Couldn't load the list of cities. Try again in a moment." };
  }
}

export type CitySuggestion = { listing: string; cities: Place[] } | null;

/** The cities that fit the project's Local SEO listing, for it to offer in the settings form. */
export async function suggestCities(projectId: number, locationCode: number): Promise<CitySuggestion> {
  await requireSession();
  const { scope } = await requireProject(projectId);
  const [business] = await listBusinesses(scope);
  const iso = marketIso(locationCode);
  if (!business || !iso) return null;
  const wanted = listingCity(business.city, business.address, iso);
  if (!wanted) return null;
  try {
    const cities = matchListing(await citiesNamed(locationCode, wanted.city), wanted).slice(0, 3);
    return cities.length ? { listing: business.city, cities } : null;
  } catch (e) {
    console.error("[places] suggest", e);
    return null;
  }
}
