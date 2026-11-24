import { describe, expect, it } from "vitest";
import { csvCell, csvLine } from "./csv";

describe("csvCell", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
  });

  it("leaves empties empty and writes objects as JSON", () => {
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
  });

  it("stops a page title running as a formula, and leaves real numbers alone", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-3.5")).toBe("-3.5");
    expect(csvCell(-3.5)).toBe("-3.5");
  });

  it("joins a line", () => {
    expect(csvLine(["a", 1, null])).toBe("a,1,\n");
  });
});
