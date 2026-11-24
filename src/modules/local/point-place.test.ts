import { describe, expect, it } from "vitest";
import { GRID_SIZES, gridPoints, RADII_MILES } from "./grid";
import { pointPlace } from "./point-place";

const SLM = { lat: 42.7885, lng: -71.2009 };

const at = (size: number, radius: number, row: number, col: number) => pointPlace(SLM, gridPoints(SLM.lat, SLM.lng, size, radius).find((p) => p.row === row && p.col === col)!);

describe("pointPlace", () => {
  it("calls the centre your listing", () => {
    expect(at(5, 5, 2, 2)).toBe("At your listing");
  });

  it("gives one distance and direction along an axis", () => {
    expect(at(5, 5, 1, 2)).toBe("2.5 mi north of your listing");
    expect(at(5, 5, 0, 2)).toBe("5 mi north of your listing");
    expect(at(5, 5, 3, 2)).toBe("2.5 mi south of your listing");
    expect(at(5, 5, 2, 0)).toBe("5 mi west of your listing");
    expect(at(5, 5, 2, 3)).toBe("2.5 mi east of your listing");
  });

  it("gives both legs off an axis", () => {
    expect(at(5, 5, 0, 0)).toBe("5 mi north and 5 mi west of your listing");
    expect(at(5, 5, 4, 3)).toBe("5 mi south and 2.5 mi east of your listing");
  });

  it("rounds to a tenth of a mile on a finer grid", () => {
    expect(at(7, 1, 2, 3)).toBe("0.3 mi north of your listing");
    expect(at(7, 5, 1, 3)).toBe("3.3 mi north of your listing");
  });

  it("treats a centre that differs only by rounding as the listing", () => {
    expect(pointPlace(SLM, { lat: SLM.lat + 0.0000001, lng: SLM.lng - 0.0000001 })).toBe("At your listing");
  });

  it("tells every point apart, on every grid size and radius", () => {
    for (const size of GRID_SIZES) {
      for (const radius of RADII_MILES) {
        const places = gridPoints(SLM.lat, SLM.lng, size, radius).map((p) => pointPlace(SLM, p));
        expect(new Set(places).size).toBe(size * size);
      }
    }
  });
});
