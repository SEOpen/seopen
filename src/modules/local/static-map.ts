// Google Maps Static API base map for the Local SEO grid: one signed image per map view instead
// of OpenStreetMap tiles. Signed and fetched on the server, so neither the signing secret nor a
// signed URL reaches the browser: the page points at /local/[businessId]/map, which serves the bytes.
import "server-only";
import { createHmac } from "node:crypto";
import { cacheLife } from "next/cache";
import { layoutTiles } from "./tiles";

/**
 * Google's own styling, not CSS filters on its imagery: grey roads and land so only the rank dots
 * carry colour, and no business or transit pins competing with them.
 */
const STYLES = ["saturation:-100|lightness:10", "feature:poi|visibility:off", "feature:transit|visibility:off"];

/** How long to wait for Google before the map falls back to OpenStreetMap. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * Signs a Maps Static API path and query with the project's URL signing secret: HMAC-SHA1 with
 * the base64url-decoded secret, appended base64url-encoded as `signature`.
 */
export function signStaticMapPath(pathAndQuery: string, secret: string): string {
  const key = Buffer.from(secret.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  const signature = createHmac("sha1", key).update(pathAndQuery).digest("base64").replace(/\+/g, "-").replace(/\//g, "_");
  return `${pathAndQuery}&signature=${signature}`;
}

/**
 * Whether the Google base map is set up. Without `GOOGLE_MAPS_STATIC_KEY` and
 * `GOOGLE_MAPS_SIGNING_SECRET` (local development) the map falls back to OpenStreetMap.
 */
export function googleStaticMapConfigured(): boolean {
  return !!process.env.GOOGLE_MAPS_STATIC_KEY && !!process.env.GOOGLE_MAPS_SIGNING_SECRET;
}

/** Everything that decides which image Google draws: the cache key for the image's bytes. */
export interface StaticMapView {
  /** "lat,lng" to six places, as it goes in the URL. */
  center: string;
  zoom: number;
  /** Width and height in map pixels: the `view` of `layoutTiles`. */
  size: number;
}

/** The view for a grid map. Centre and zoom match `layoutTiles`, so the points land where the client places them. */
export function staticMapView(center: { lat: number; lng: number }, points: { lat: number; lng: number }[]): StaticMapView {
  const { zoom, view } = layoutTiles(center, points);
  return { center: `${center.lat.toFixed(6)},${center.lng.toFixed(6)}`, zoom, size: view };
}

function signedUrl(view: StaticMapView, key: string, secret: string): string {
  const params = [
    `center=${view.center}`,
    `zoom=${view.zoom}`,
    `size=${view.size}x${view.size}`,
    "scale=2",
    "maptype=roadmap",
    ...STYLES.map((s) => `style=${encodeURIComponent(s)}`),
    `key=${encodeURIComponent(key)}`,
  ];
  return `https://maps.googleapis.com${signStaticMapPath(`/maps/api/staticmap?${params.join("&")}`, secret)}`;
}

/**
 * The signed image URL for a grid map, or null when the Google base map isn't set up. Server only:
 * a signed URL loads forever for anyone who has it, so it must never be sent to the browser.
 */
export function googleStaticMapUrl(center: { lat: number; lng: number }, points: { lat: number; lng: number }[]): string | null {
  const key = process.env.GOOGLE_MAPS_STATIC_KEY;
  const secret = process.env.GOOGLE_MAPS_SIGNING_SECRET;
  if (!key || !secret) return null;
  return signedUrl(staticMapView(center, points), key, secret);
}

/** Where the page loads a check's map image from: the signed-in route, never Google itself. */
export function staticMapHref(businessId: number, checkId: number, keywordId: number): string {
  return `/local/${businessId}/map?check=${checkId}&k=${keywordId}`;
}

export class StaticMapError extends Error {}

/**
 * The map image's bytes from Google, kept in the shared remote cache (where the host has one) for the `days` profile: reused for a day, then refreshed on the next view, and
 * dropped after a week unseen. Google's terms restrict caching its content, so this stays short;
 * whether caching map images is allowed at all is still an open legal question.
 * The key is only the view, so every check of a business, and every keyword on it, shares one
 * image. A deploy starts a fresh cache. A failure throws, so it's never cached and the next view
 * asks Google again.
 */
export async function staticMapImage(view: StaticMapView): Promise<{ contentType: string; bytes: Uint8Array<ArrayBuffer> }> {
  "use cache: remote";
  cacheLife("days");
  const key = process.env.GOOGLE_MAPS_STATIC_KEY;
  const secret = process.env.GOOGLE_MAPS_SIGNING_SECRET;
  if (!key || !secret) throw new StaticMapError("The Google base map isn't set up.");
  const res = await fetch(signedUrl(view, key, secret), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const contentType = res.headers.get("content-type") ?? "";
  // Google answers a bad key or signature with a text error, sometimes under a 200.
  if (!res.ok || !contentType.startsWith("image/")) throw new StaticMapError(`Maps Static API answered ${res.status}.`);
  return { contentType, bytes: new Uint8Array(await res.arrayBuffer()) };
}
