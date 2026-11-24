import { LOCATIONS } from "@/lib/dataforseo/locations";

/**
 * Countries and their best-known cities, for spotting a Google keyword idea that names somewhere
 * outside the project's market ("website seo london" for a Salem designer). Kept deliberately
 * short and unambiguous: names that are also common US towns or words (Georgia, Jordan, Turkey,
 * Birmingham, Naples, Florence, Perth, Vienna, Moscow, Lima, Cork, Holland) are left out, since a
 * miss only keeps an idea while a false hit would drop a good one. Keys match `LOCATIONS` names;
 * any other key is a country no market here covers, so it's foreign to every project.
 */
const PLACES: Record<string, string[]> = {
  "United States": ["united states", "usa", "new york", "los angeles", "chicago", "san francisco", "new mexico", "new england"],
  "United Kingdom": ["united kingdom", "uk", "england", "scotland", "wales", "britain", "great britain", "london", "glasgow", "edinburgh", "liverpool", "leeds"],
  Canada: ["canada", "toronto", "vancouver", "montreal", "calgary", "ottawa", "edmonton"],
  Australia: ["australia", "sydney", "melbourne", "brisbane", "adelaide", "new south wales"],
  "New Zealand": ["new zealand", "nz", "auckland"],
  Ireland: ["ireland", "dublin"],
  India: ["india", "bangalore", "bengaluru", "mumbai", "delhi", "new delhi", "hyderabad", "chennai", "pune", "kolkata", "ahmedabad", "noida", "gurgaon", "gurugram", "jaipur", "kerala"],
  Germany: ["germany", "deutschland", "berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln"],
  France: ["france", "lyon", "marseille"],
  Spain: ["spain", "españa", "madrid", "barcelona"],
  Mexico: ["mexico", "méxico", "mexico city", "guadalajara", "monterrey"],
  Brazil: ["brazil", "brasil", "sao paulo", "são paulo", "rio de janeiro"],
  Italy: ["italy", "italia", "milan", "milano"],
  Netherlands: ["netherlands", "amsterdam", "rotterdam"],
  Sweden: ["sweden", "stockholm", "gothenburg"],
  Japan: ["japan", "tokyo", "osaka", "kyoto"],
  Pakistan: ["pakistan", "karachi", "lahore", "islamabad"],
  Bangladesh: ["bangladesh", "dhaka"],
  Philippines: ["philippines", "manila"],
  UAE: ["uae", "dubai", "abu dhabi"],
  Singapore: ["singapore"],
  Nigeria: ["nigeria", "lagos"],
  "South Africa": ["south africa", "cape town", "johannesburg"],
  Kenya: ["kenya", "nairobi"],
  "Hong Kong": ["hong kong"],
  Malaysia: ["malaysia", "kuala lumpur"],
  Indonesia: ["indonesia", "jakarta"],
  Vietnam: ["vietnam"],
  Egypt: ["egypt", "cairo"],
  Israel: ["israel", "tel aviv"],
  Poland: ["poland", "warsaw"],
  Portugal: ["portugal", "lisbon"],
  Belgium: ["belgium", "brussels"],
  Switzerland: ["switzerland", "zurich"],
  Denmark: ["denmark", "copenhagen"],
  Norway: ["norway", "oslo"],
  Finland: ["finland", "helsinki"],
  Ukraine: ["ukraine", "kyiv"],
  Argentina: ["argentina", "buenos aires"],
  Colombia: ["colombia", "bogota"],
};

/** Every name with its country, longest first, so "new mexico" is read before "mexico" and "new south wales" before "wales". */
const NAMES = Object.entries(PLACES)
  .flatMap(([country, names]) => names.map((name) => ({ name, country })))
  .sort((a, b) => b.name.length - a.name.length);

/**
 * The place a keyword names outside the project's country, or null. Null too when the market isn't
 * one we know, and for a place among the business's own towns (a London, Ontario firm keeps "london").
 */
export function foreignPlace(keyword: string, locationCode: number | undefined, ownTowns: string[] = []): string | null {
  const home = LOCATIONS.find((l) => l.code === locationCode)?.name;
  if (!home) return null;
  const own = ownTowns.join(" ").toLowerCase();
  let text = ` ${keyword.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
  for (const { name, country } of NAMES) {
    if (!text.includes(` ${name} `)) continue;
    if (country !== home && !own.includes(name)) return name;
    // Consumed, so the shorter names inside it ("mexico" in "new mexico") don't match again.
    text = text.replace(` ${name} `, " ");
  }
  return null;
}
