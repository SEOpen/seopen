import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Tabs } from "./tabs";

vi.mock("next/navigation", () => ({
  usePathname: () => "/keywords/ideas",
  useSearchParams: () => new URLSearchParams("q=coffee&run=1"),
}));

// The real Link drops `prefetch` from its markup, so this one shows it.
vi.mock("next/link", () => ({
  default: ({ href, prefetch, className, children, "aria-current": current }: { href: string; prefetch?: boolean; className?: string; children: ReactNode; "aria-current"?: "page" }) => (
    <a href={href} data-prefetch={String(prefetch)} aria-current={current} className={className}>
      {children}
    </a>
  ),
}));

const TABS = [
  { href: "/keywords", label: "Overview" },
  { href: "/keywords/ideas", label: "Ideas" },
];

const helpLinks = (html: string) => html.match(/<a [^>]*>How this works<\/a>/g) ?? [];

describe("Tabs", () => {
  it("marks the active tab and never carries run", () => {
    const html = renderToStaticMarkup(<Tabs tabs={TABS} helpHref="/docs/features/keyword-research" />);
    expect(html).toContain('href="/keywords/ideas?q=coffee" data-prefetch="undefined" aria-current="page"');
    expect(html).not.toContain("run=1");
  });

  it("draws the help link once per width: in the scrolling part on a phone, outside it otherwise", () => {
    const html = renderToStaticMarkup(<Tabs tabs={TABS} helpHref="/docs/features/keyword-research" />);
    const [inRow, outside] = html.split("</nav>").map(helpLinks);
    expect(inRow).toHaveLength(1);
    expect(inRow[0]).toContain("@2xl/main:hidden");
    expect(outside).toHaveLength(1);
    expect(outside[0]).toContain("@max-2xl/main:hidden");
  });

  it("has no help link for a row with no docs page", () => {
    expect(helpLinks(renderToStaticMarkup(<Tabs tabs={TABS} helpHref={null} />))).toEqual([]);
  });
});
