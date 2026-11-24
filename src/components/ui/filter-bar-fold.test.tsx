import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./filter-bar";

vi.mock("next/navigation", () => ({
  usePathname: () => "/rank",
  useRouter: () => ({ replace: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const checkbox = (html: string) => html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";

describe("FilterBar fold", () => {
  it("adds nothing unless a page asks for it", () => {
    const html = renderToStaticMarkup(
      <FilterBar>
        <select name="bucket" />
      </FilterBar>,
    );
    expect(checkbox(html)).toBe("");
    expect(words(html)).not.toContain("Filters");
  });

  it("starts closed with nothing active, and doesn't show a zero", () => {
    const html = renderToStaticMarkup(
      <FilterBar fold={{ active: 0 }}>
        <select name="bucket" />
      </FilterBar>,
    );
    expect(checkbox(html)).not.toContain("checked");
    expect(words(html)).toBe("Filters Apply");
  });

  it("starts open and counts the filters when any are active", () => {
    const html = renderToStaticMarkup(
      <FilterBar fold={{ active: 2 }}>
        <select name="bucket" />
      </FilterBar>,
    );
    expect(checkbox(html)).toContain("checked");
    expect(words(html)).toContain("Filters 2 active");
  });

  it("keeps its checkbox out of the query, by having no name", () => {
    const html = renderToStaticMarkup(
      <FilterBar fold={{ active: 1 }}>
        <select name="bucket" />
      </FilterBar>,
    );
    expect(checkbox(html)).not.toContain("name=");
  });
});
