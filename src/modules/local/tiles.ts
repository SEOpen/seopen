// A tiny Web Mercator tile layout for the grid map: which OpenStreetMap raster tiles to draw and
// where each point sits, with no map library and no API key. Pure, so it is unit tested.

export const TILE_PX = 256;
/** The tightest crop, in map pixels. The map shows at up to 600px, so this is at most about 1.5x. */
const MIN_VIEW = 384;

/** World pixel coordinates of a point at zoom `z` (Web Mercator, as every slippy map uses). */
export function toPixel(lat: number, lng: number, z: number): { x: number; y: number } {
  const size = TILE_PX * 2 ** z;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return {
    x: ((lng + 180) / 360) * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size,
  };
}

export interface TileLayout {
  zoom: number;
  /** Size of the square view in pixels (the SVG viewBox). */
  view: number;
  tiles: { x: number; y: number; z: number; left: number; top: number }[];
  /** Where to draw a point in the view, as a 0–1 share of its width and height. */
  place: (lat: number, lng: number) => { left: number; top: number };
}

/**
 * The tiles that cover a square map centred on (lat, lng), at the highest zoom where every point
 * fits inside `fill` of `maxView` pixels. Zoom only moves in steps of two, which could leave the grid
 * filling half the map, so the view is then cropped in to the grid, no smaller than MIN_VIEW so the
 * map's labels don't blow up. The zoom is clamped to what tile servers offer.
 */
export function layoutTiles(center: { lat: number; lng: number }, points: { lat: number; lng: number }[], maxView = 640, fill = 0.78): TileLayout {
  let zoom = 3;
  for (let z = 18; z >= 3; z--) {
    const c = toPixel(center.lat, center.lng, z);
    const fits = points.every((p) => {
      const q = toPixel(p.lat, p.lng, z);
      return Math.abs(q.x - c.x) <= (maxView * fill) / 2 && Math.abs(q.y - c.y) <= (maxView * fill) / 2;
    });
    if (fits) {
      zoom = z;
      break;
    }
  }
  const c = toPixel(center.lat, center.lng, zoom);
  const reach = Math.max(
    0,
    ...points.map((p) => {
      const q = toPixel(p.lat, p.lng, zoom);
      return Math.max(Math.abs(q.x - c.x), Math.abs(q.y - c.y));
    }),
  );
  const view = Math.max(Math.min(MIN_VIEW, maxView), Math.min(maxView, Math.ceil((reach * 2) / fill)));
  const ox = c.x - view / 2;
  const oy = c.y - view / 2;
  const max = 2 ** zoom;
  const tiles: TileLayout["tiles"] = [];
  for (let ty = Math.floor(oy / TILE_PX); ty <= Math.floor((oy + view - 1) / TILE_PX); ty++) {
    if (ty < 0 || ty >= max) continue;
    for (let tx = Math.floor(ox / TILE_PX); tx <= Math.floor((ox + view - 1) / TILE_PX); tx++) {
      tiles.push({ x: ((tx % max) + max) % max, y: ty, z: zoom, left: tx * TILE_PX - ox, top: ty * TILE_PX - oy });
    }
  }
  return {
    zoom,
    view,
    tiles,
    place: (lat, lng) => {
      const q = toPixel(lat, lng, zoom);
      return { left: (q.x - ox) / view, top: (q.y - oy) / view };
    },
  };
}

/** The standard OpenStreetMap raster tile. Its usage policy asks for the attribution shown on the map. */
export function osmTileUrl(t: { x: number; y: number; z: number }): string {
  return `https://tile.openstreetmap.org/${t.z}/${t.x}/${t.y}.png`;
}

/** Distance in miles and compass direction from `from` to `to`, e.g. { mi: 2.5, dir: "north-west" }. */
export function offsetFrom(from: { lat: number; lng: number }, to: { lat: number; lng: number }): { mi: number; dir: string | null } {
  const north = ((to.lat - from.lat) * 111.32) / 1.609344;
  const east = ((to.lng - from.lng) * 111.32 * Math.cos((from.lat * Math.PI) / 180)) / 1.609344;
  const mi = Math.hypot(north, east);
  if (mi < 0.03) return { mi: 0, dir: null };
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  const deg = (Math.atan2(east, north) * 180) / Math.PI;
  return { mi: Math.round(mi * 10) / 10, dir: names[Math.round(((deg + 360) % 360) / 45) % 8] };
}
