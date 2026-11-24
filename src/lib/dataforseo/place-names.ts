/** Pure helpers for DataForSEO's place names: no database or API here. */

/** A place as the app shows it. */
export interface Place {
  code: number;
  name: string;
}

/** Location types a project can search from. Postal codes, airports and universities aren't places people target. */
export const CITY_TYPES = new Set(["City", "Municipality", "Borough"]);

/**
 * "Salem,New Hampshire,United States" → "Salem, New Hampshire".
 * Drops the country and repeated parts ("Berlin,Berlin,Germany" → "Berlin").
 */
export function placeName(locationName: string): string {
  const parts = locationName.split(",").map((p) => p.trim()).filter(Boolean);
  const named = parts.length > 1 ? parts.slice(0, -1) : parts;
  return named.filter((p, i) => p !== named[i - 1]).join(", ");
}

const US_STATES: Record<string, string> = {
  al: "Alabama", ak: "Alaska", az: "Arizona", ar: "Arkansas", ca: "California", co: "Colorado", ct: "Connecticut", de: "Delaware",
  dc: "District of Columbia", fl: "Florida", ga: "Georgia", hi: "Hawaii", id: "Idaho", il: "Illinois", in: "Indiana", ia: "Iowa",
  ks: "Kansas", ky: "Kentucky", la: "Louisiana", me: "Maine", md: "Maryland", ma: "Massachusetts", mi: "Michigan", mn: "Minnesota",
  ms: "Mississippi", mo: "Missouri", mt: "Montana", ne: "Nebraska", nv: "Nevada", nh: "New Hampshire", nj: "New Jersey", nm: "New Mexico",
  ny: "New York", nc: "North Carolina", nd: "North Dakota", oh: "Ohio", ok: "Oklahoma", or: "Oregon", pa: "Pennsylvania", ri: "Rhode Island",
  sc: "South Carolina", sd: "South Dakota", tn: "Tennessee", tx: "Texas", ut: "Utah", vt: "Vermont", va: "Virginia", wa: "Washington",
  wv: "West Virginia", wi: "Wisconsin", wy: "Wyoming",
};

/** "NH" → "New Hampshire" in the US; anything else unchanged. */
export function regionName(region: string, iso: string): string {
  return (iso === "us" && US_STATES[region.trim().toLowerCase()]) || region.trim();
}

/** "Texas" → "tx", or null for anything that isn't a US state's name. */
export function regionAbbr(region: string): string | null {
  const name = region.trim().toLowerCase();
  return Object.entries(US_STATES).find(([, n]) => n.toLowerCase() === name)?.[0] ?? null;
}

/** US states as a text may name them: "TX" and "Texas". */
export const stateNames = () => Object.entries(US_STATES).flatMap(([abbr, name]) => [abbr.toUpperCase(), name]);

/** A town's name for comparing spellings: lower case, no dots, "Saint" as "St", "Fort" as "Ft", "Mount" as "Mt". */
export const placeKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\bsaint\b/g, "st")
    .replace(/\bfort\b/g, "ft")
    .replace(/\bmount\b/g, "mt")
    .replace(/\s+/g, " ")
    .trim();

/** A LIKE pattern for what someone typed into the city box: "salem nh" → "salem, new hampshire%". Null when too short to search. */
export function cityPattern(query: string, iso: string): string | null {
  const q = query.trim().toLowerCase().replace(/[%_\\]/g, "");
  if (q.length < 2) return null;
  const words = q.split(/[\s,]+/).filter(Boolean);
  if (iso === "us" && words.length > 1) {
    const state = US_STATES[words[words.length - 1]];
    if (state) return `${words.slice(0, -1).join(" ")}, ${state.toLowerCase()}%`;
  }
  return `${words.join("%")}%`;
}

/**
 * The city and, if it can tell, the region of a Local SEO listing: from what was typed for it
 * ("Salem, NH") and, when that names no region, its address ("1 Main St, Salem, NH 03079").
 */
export function listingCity(city: string, address: string | null, iso: string): { city: string; region: string | null } | null {
  const [name, ...rest] = city.split(",").map((p) => p.trim()).filter(Boolean);
  if (!name) return null;
  const typed = rest[0] ?? null;
  const fromAddress = iso === "us" ? address?.match(/,\s*([A-Za-z]{2})\s+\d{5}/)?.[1] : null;
  const region = typed ?? fromAddress ?? null;
  return { city: name, region: region ? regionName(region, iso) : null };
}

/** The places that fit a listing's city, closest first. A place in the wrong region is left out once the region is known. */
export function matchListing<T extends Place>(places: T[], wanted: { city: string; region: string | null }): T[] {
  const city = wanted.city.toLowerCase();
  const sameCity = places.filter((p) => p.name.split(",")[0].trim().toLowerCase() === city);
  if (!wanted.region) return sameCity;
  const region = wanted.region.toLowerCase();
  return sameCity.filter((p) => p.name.toLowerCase().split(",").slice(1).some((part) => part.trim() === region));
}

/** Google Ads refuses a task with one of these in it, or a keyword over 80 characters or 10 words. */
const ADS_REFUSED = /[,!@%^()={};~`<>?\\|]/;

export function adsAccepts(keyword: string): boolean {
  return keyword.length <= 80 && keyword.trim().split(/\s+/).length <= 10 && !ADS_REFUSED.test(keyword);
}
