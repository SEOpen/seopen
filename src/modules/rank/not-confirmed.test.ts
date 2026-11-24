import { describe, expect, it, vi } from "vitest";
import { pageOneGainsInRows } from "./not-confirmed";

vi.mock("server-only", () => ({}));

describe("pageOneGainsInRows", () => {
  it("counts what's on page one only on a position no look confirmed, and wasn't at the start", () => {
    const rows = [
      { position: 3, start: 15, notChecked: true },
      { position: 9, start: null, notChecked: true },
      { position: 3, start: 15, notChecked: false }, // Confirmed: a real gain.
      { position: 4, start: 4, notChecked: true }, // Already there.
      { position: 12, start: 30, notChecked: true }, // Not on page one.
      { position: null, start: 4, notChecked: true },
    ];
    expect(pageOneGainsInRows(rows)).toBe(2);
  });
});
