import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PageHeader } from "./page-header";

// The real Link drops `prefetch` from its markup, so this one shows it.
vi.mock("next/link", () => ({
  default: ({ href, prefetch, className, children }: { href: string; prefetch?: boolean; className?: string; children: ReactNode }) => (
    <a href={href} data-prefetch={String(prefetch)} className={className}>
      {children}
    </a>
  ),
}));

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("PageHeader", () => {
  it("has no link unless it's given one", () => {
    expect(renderToStaticMarkup(<PageHeader title="Rankings" description="From Google." />)).not.toContain("<a");
    expect(renderToStaticMarkup(<PageHeader title="Rankings" description="From Google." helpHref={null} />)).not.toContain("<a");
  });

  it("runs the link on from the description, in the same block", () => {
    const html = renderToStaticMarkup(<PageHeader title="Analytics" description="From GA4." helpHref="/docs/features/analytics" />);
    expect(words(html)).toBe("Analytics From GA4. How this works");
    expect(html).toContain('href="/docs/features/analytics"');
    expect(html.match(/<div class="mt-1[^"]*">/g)).toHaveLength(1);
    expect(html).toMatch(/From GA4\. <a /);
  });

  it("opens the docs in a new tab, outside the app's router", () => {
    const html = renderToStaticMarkup(<PageHeader title="Analytics" helpHref="/docs/features/analytics" />);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
    expect(html).not.toContain("data-prefetch");
  });

  it("keeps it muted and whole, so it can wrap as one piece but not widen a phone", () => {
    const html = renderToStaticMarkup(<PageHeader title="Analytics" helpHref="/docs/features/analytics" />);
    for (const name of ["text-xs", "text-muted", "hover:text-fg", "whitespace-nowrap"]) expect(html).toContain(name);
  });

  it("stays usable from a server component", () => {
    const source = readFileSync(fileURLToPath(new URL("./page-header.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("use client");
    expect(source).not.toMatch(/\buse[A-Z]\w*\(/);
  });
});
