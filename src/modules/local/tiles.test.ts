import { describe, expect, it } from "vitest";
import { layoutTiles, toPixel } from "./tiles";

const center = { lat: 32.85, lng: -79.97 };

/** A square grid of points, `reach` degrees of latitude and longitude either side of the centre. */
function grid(reach: number) {
  const steps = [-1, -0.5, 0, 0.5, 1];
  return steps.flatMap((a) => steps.map((b) => ({ lat: center.lat + a * reach, lng: center.lng + b * reach })));
}

function share(reach: number) {
  const points = grid(reach);
  const { place } = layoutTiles(center, points);
  const spots = points.map((p) => place(p.lat, p.lng));
  const lefts = spots.map((s) => s.left);
  return { spots, width: Math.max(...lefts) - Math.min(...lefts) };
}

describe("layoutTiles", () => {
  it.each([0.01, 0.03, 0.05, 0.07, 0.1, 0.2])("keeps a grid %f degrees wide inside the map, and fills most of it", (reach) => {
    const { spots, width } = share(reach);
    for (const s of spots) {
      expect(s.left).toBeGreaterThan(0.05);
      expect(s.left).toBeLessThan(0.95);
      expect(s.top).toBeGreaterThan(0.05);
      expect(s.top).toBeLessThan(0.95);
    }
    expect(width).toBeGreaterThan(0.6);
  });

  it("never asks for more than Google's 640 pixel limit, or a view smaller than its crop", () => {
    for (const reach of [0.001, 0.05, 0.5]) {
      const { view } = layoutTiles(center, grid(reach));
      expect(view).toBeLessThanOrEqual(640);
      expect(view).toBeGreaterThanOrEqual(384);
    }
  });

  it("covers the whole view with tiles after the crop", () => {
    const { tiles, view, zoom } = layoutTiles(center, grid(0.05));
    expect(tiles.every((t) => t.z === zoom)).toBe(true);
    expect(Math.min(...tiles.map((t) => t.left))).toBeLessThanOrEqual(0);
    expect(Math.max(...tiles.map((t) => t.left + 256))).toBeGreaterThanOrEqual(view);
    expect(toPixel(center.lat, center.lng, zoom).x).toBeGreaterThan(0);
  });
});
