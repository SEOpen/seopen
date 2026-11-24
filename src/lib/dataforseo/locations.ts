/** Common DataForSEO markets. Codes from the free appendix endpoint serp/google/locations. */
export const LOCATIONS = [
  { code: 2840, name: "United States", languageCode: "en", iso: "us" },
  { code: 2826, name: "United Kingdom", languageCode: "en", iso: "gb" },
  { code: 2124, name: "Canada", languageCode: "en", iso: "ca" },
  { code: 2036, name: "Australia", languageCode: "en", iso: "au" },
  { code: 2554, name: "New Zealand", languageCode: "en", iso: "nz" },
  { code: 2372, name: "Ireland", languageCode: "en", iso: "ie" },
  { code: 2356, name: "India", languageCode: "en", iso: "in" },
  { code: 2276, name: "Germany", languageCode: "de", iso: "de" },
  { code: 2250, name: "France", languageCode: "fr", iso: "fr" },
  { code: 2724, name: "Spain", languageCode: "es", iso: "es" },
  { code: 2484, name: "Mexico", languageCode: "es", iso: "mx" },
  { code: 2076, name: "Brazil", languageCode: "pt", iso: "br" },
  { code: 2380, name: "Italy", languageCode: "it", iso: "it" },
  { code: 2528, name: "Netherlands", languageCode: "nl", iso: "nl" },
  { code: 2752, name: "Sweden", languageCode: "sv", iso: "se" },
  { code: 2392, name: "Japan", languageCode: "ja", iso: "jp" },
] as const;

export function locationName(code: number): string {
  return LOCATIONS.find((l) => l.code === code)?.name ?? `Location ${code}`;
}

/** The ISO code DataForSEO's per-country location list goes by, or null for a market we don't list. */
export function marketIso(code: number): string | null {
  return LOCATIONS.find((l) => l.code === code)?.iso ?? null;
}

/**
 * Where a project's rankings are searched from: its city, else its country. Only rank tracking and
 * the live top 10 use this. Everything else stays on `locationCode`, because DataForSEO Labs
 * (Domain analysis, keyword metrics and ideas) answers a city code with 40501.
 */
export function trackedLocation(project: { locationCode: number; cityCode: number | null }): number {
  return project.cityCode ?? project.locationCode;
}

/** The name of `trackedLocation`: "Salem, New Hampshire", or "United States". */
export function trackedPlaceName(project: { locationCode: number; cityName: string | null }): string {
  return project.cityName ?? locationName(project.locationCode);
}
