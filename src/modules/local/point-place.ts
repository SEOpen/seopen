import { offsetFrom } from "./tiles";

type Spot = { lat: number; lng: number };

/**
 * Where a grid point sits, in words: "2.5 mi north of your listing", "5 mi north and 2.5 mi west of your
 * listing", or "At your listing". Read from the point's own coordinates, so it holds for any grid size and
 * radius. Off an axis it gives both legs rather than one compass bearing, because on a square grid two
 * different points can share a distance and a bearing: 5 north 2.5 west and 2.5 north 5 west are both
 * 5.6 mi north-west.
 */
export function pointPlace(center: Spot, point: Spot): string {
  const legs = [offsetFrom(center, { lat: point.lat, lng: center.lng }), offsetFrom(center, { lat: center.lat, lng: point.lng })].filter((leg) => leg.dir);
  if (!legs.length) return "At your listing";
  return `${legs.map((leg) => `${leg.mi} mi ${leg.dir}`).join(" and ")} of your listing`;
}
