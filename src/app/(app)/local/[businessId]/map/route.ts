import { getCurrentUser } from "@/lib/auth/session";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { getBusinessCheck, loadPoints } from "@/modules/local/queries";
import { googleStaticMapConfigured, staticMapImage, staticMapView } from "@/modules/local/static-map";
import { getBusiness } from "@/modules/local/tracker";

const NO_STORE = { "Cache-Control": "no-store" };

/** Postgres refuses a bigger number for an integer column, and a URL can hold any number. */
const id = (v: string | null) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
};

/**
 * GET /local/[businessId]/map?check=ID&k=ID: the Google base map under one check's grid, as image
 * bytes. The signed Maps Static URL is built and fetched here, so it never reaches the browser and
 * can't be replayed. The map's view comes from the stored check and its points, never from the
 * query, so a caller can only ask for maps of its own checks, and repeat views come from the cache
 * in `staticMapImage`. The proxy already keeps signed-out visitors away; this checks again.
 */
export async function GET(request: Request, { params }: RouteContext<"/local/[businessId]/map">) {
  if (!(await getCurrentUser())) return new Response("Unauthorized", { status: 401, headers: NO_STORE });
  // Without the Google key and secret the page draws OpenStreetMap and never asks here.
  if (!googleStaticMapConfigured()) return new Response("Not found", { status: 404, headers: NO_STORE });

  const query = new URL(request.url).searchParams;
  const businessId = id((await params).businessId);
  const checkId = id(query.get("check"));
  const keywordId = id(query.get("k"));
  const project = await getCurrentProject();
  if (!project || !businessId || !checkId || !keywordId) return new Response("Not found", { status: 404, headers: NO_STORE });
  const scope = projectScope(project);
  const business = await getBusiness(scope, businessId);
  const check = business ? await getBusinessCheck(scope, business.id, checkId) : null;
  const points = check ? await loadPoints(scope, check.id, keywordId) : [];
  if (!check || !points.length) return new Response("Not found", { status: 404, headers: NO_STORE });

  try {
    const image = await staticMapImage(staticMapView({ lat: check.lat, lng: check.lng }, points));
    return new Response(image.bytes, {
      // Private: the image only goes to the signed-in browser, never a shared cache.
      headers: { "Content-Type": image.contentType, "Cache-Control": "private, max-age=86400" },
    });
  } catch (e) {
    // The page falls back to OpenStreetMap when the image doesn't load.
    console.error("Local map image failed:", e instanceof Error ? e.message : e);
    return new Response("Map unavailable", { status: 502, headers: NO_STORE });
  }
}
