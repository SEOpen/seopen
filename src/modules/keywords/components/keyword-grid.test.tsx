import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { KeywordGrid } from "./keyword-grid";

/** A keyword links to its research in the market it came from. */

vi.mock("../actions", () => ({ addToList: vi.fn(), removeFromList: vi.fn() }));

const columns = [{ key: "keyword", label: "Keyword", format: "keyword" as const }];

describe("the keyword link", () => {
  it("carries the grid's market", () => {
    const html = renderToStaticMarkup(<KeywordGrid rows={[{ keyword: "cold brew" }]} columns={columns} filename="x" lists={[]} market={{ locationCode: 2826, languageCode: "en" }} />);
    expect(html).toContain('href="/keywords?q=cold+brew&amp;loc=2826"');
  });

  it("carries a saved keyword's own market over the grid's", () => {
    const html = renderToStaticMarkup(<KeywordGrid rows={[{ keyword: "cold brew", locationCode: 2036 }]} columns={columns} filename="x" lists={null} />);
    expect(html).toContain('href="/keywords?q=cold+brew&amp;loc=2036"');
  });
});
