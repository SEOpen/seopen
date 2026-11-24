import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PageFailure } from "./page-failure";

const transition = vi.hoisted(() => ({ pending: false }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useTransition: () => [transition.pending, (fn: () => void) => fn()],
}));

const html = () => renderToStaticMarkup(<PageFailure error={new Error("x")} retry={() => {}} help="" />);

describe("PageFailure", () => {
  it("offers Try again", () => {
    transition.pending = false;
    expect(html()).toContain("Try again</button>");
    expect(html()).toContain('aria-busy="false"');
  });

  it("shows it's working while the page reloads, and can't be pressed twice", () => {
    transition.pending = true;
    const page = html();
    expect(page).toContain("Retrying</button>");
    expect(page).toContain('aria-busy="true"');
    expect(page).toMatch(/<button[^>]*\bdisabled=""/);
    expect(page).toContain("motion-reduce:animate-none");
  });
});
