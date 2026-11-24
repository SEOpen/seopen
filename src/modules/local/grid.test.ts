import { describe, expect, it } from "vitest";
import { estimateCheckUsd, gridPoints, gridSpacingMiles, isGridSize, isRadius, locationCoordinate, priceLabel, PRICE_PER_POINT_USD, zoomForRadius } from "./grid";
import { layoutTiles, offsetFrom, toPixel } from "./tiles";
import { rules } from "@/plan-policy/rules";

describe("priceLabel", () => {
  it.skipIf(!rules.hasPlans)("shows credits, and dollars only where the workspace sees them", () => {
    expect(priceLabel(0.09, false)).toBe("≈ 9 credits");
    expect(priceLabel(0.09, true)).toBe("≈ 9 credits · $0.090");
  });

  it.skipIf(!rules.hasPlans)("stays balanced inside a button's brackets", () => {
    expect(`Check now (${priceLabel(0.09, true)})`).toBe("Check now (≈ 9 credits · $0.090)");
  });

  it.skipIf(rules.hasPlans)("says dollars once without plans", () => {
    expect(priceLabel(0.09, false)).toBe("≈ $0.09");
    expect(`Check now (${priceLabel(0.09, true)})`).toBe("Check now (≈ $0.09)");
  });
});

const SLM = { lat: 42.7885, lng: -71.2009 };
const mi = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => offsetFrom(a, b).mi;

describe("gridPoints", () => {
  it("makes n×n points, rows north to south and columns west to east", () => {
    const pts = gridPoints(SLM.lat, SLM.lng, 5, 8);
    expect(pts).toHaveLength(25);
    expect(pts[0]).toMatchObject({ row: 0, col: 0 });
    expect(pts[24]).toMatchObject({ row: 4, col: 4 });
    expect(pts[0].lat).toBeGreaterThan(pts[24].lat);
    expect(pts[0].lng).toBeLessThan(pts[24].lng);
  });

  it("puts the middle point of an odd grid on the listing", () => {
    for (const n of [3, 5, 7]) {
      const mid = gridPoints(SLM.lat, SLM.lng, n, 5).find((p) => p.row === (n - 1) / 2 && p.col === (n - 1) / 2)!;
      expect(mid.lat).toBeCloseTo(SLM.lat, 6);
      expect(mid.lng).toBeCloseTo(SLM.lng, 6);
    }
  });

  it("puts the edge points `radius` miles from the centre, even spacing between", () => {
    const pts = gridPoints(SLM.lat, SLM.lng, 5, 5);
    const north = pts.find((p) => p.row === 0 && p.col === 2)!;
    const east = pts.find((p) => p.row === 2 && p.col === 4)!;
    expect(mi(SLM, north)).toBeCloseTo(5, 1);
    expect(mi(SLM, east)).toBeCloseTo(5, 1);
    expect(offsetFrom(SLM, north).dir).toBe("north");
    expect(offsetFrom(SLM, east).dir).toBe("east");
    expect(mi(pts[0], pts[1])).toBeCloseTo(gridSpacingMiles(5, 5), 1);
    expect(gridSpacingMiles(5, 5)).toBe(2.5);
  });

  it("rejects a bad size", () => {
    expect(() => gridPoints(0, 0, 0, 5)).toThrow();
    expect(gridPoints(0, 0, 1, 5)).toEqual([{ row: 0, col: 0, lat: 0, lng: 0 }]);
  });
});

describe("grid options and cost", () => {
  it("allows the offered sizes and radii only", () => {
    expect([3, 5, 7].every(isGridSize)).toBe(true);
    expect(isGridSize(4)).toBe(false);
    expect([1, 3, 5, 10].every(isRadius)).toBe(true);
    expect(isRadius(8)).toBe(false);
  });

  it("zooms out as the radius grows", () => {
    expect([1, 3, 5, 10].map(zoomForRadius)).toEqual([15, 14, 13, 12]);
  });

  it("formats DataForSEO's location_coordinate", () => {
    expect(locationCoordinate(42.78850001234, -71.2009, 13)).toBe("42.7885,-71.2009,13z");
  });

  it("prices a check as points × keywords × task price", () => {
    expect(estimateCheckUsd(5, 2)).toBeCloseTo(50 * PRICE_PER_POINT_USD, 10);
    expect(estimateCheckUsd(3, 1)).toBeCloseTo(9 * PRICE_PER_POINT_USD, 10);
    expect(estimateCheckUsd(7, 0)).toBe(0);
  });
});

describe("tiles", () => {
  it("projects like a slippy map", () => {
    expect(toPixel(0, 0, 0)).toEqual({ x: 128, y: 128 });
    expect(toPixel(0, -180, 1).x).toBe(0);
  });

  it("fits the whole grid in view and centres the listing", () => {
    for (const r of [1, 3, 5, 10]) {
      const pts = gridPoints(SLM.lat, SLM.lng, 7, r);
      const l = layoutTiles(SLM, pts);
      for (const p of pts) {
        const q = l.place(p.lat, p.lng);
        expect(q.left).toBeGreaterThan(0.05);
        expect(q.left).toBeLessThan(0.95);
        expect(q.top).toBeGreaterThan(0.05);
        expect(q.top).toBeLessThan(0.95);
      }
      const c = l.place(SLM.lat, SLM.lng);
      expect(c.left).toBeCloseTo(0.5, 6);
      expect(c.top).toBeCloseTo(0.5, 6);
      // A wider grid never gets a closer zoom.
      expect(l.zoom).toBeLessThanOrEqual(layoutTiles(SLM, gridPoints(SLM.lat, SLM.lng, 7, Math.max(1, r - 1))).zoom);
      // The tiles cover the whole view.
      const left = Math.min(...l.tiles.map((t) => t.left));
      const right = Math.max(...l.tiles.map((t) => t.left + 256));
      expect(left).toBeLessThanOrEqual(0);
      expect(right).toBeGreaterThanOrEqual(l.view);
    }
  });
});
