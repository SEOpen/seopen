import { describe, expect, it } from "vitest";
import type { safeFetch } from "@/lib/web/fetch";
import { readSitemap } from "./sitemap";

const site = (files: Record<string, string>) => {
  const asked: string[] = [];
  const fetch = (async (url: string) => {
    asked.push(url);
    const body = files[url];
    return { url, status: body === undefined ? 404 : 200, headers: {}, body: body ?? "", truncated: false, redirects: [], ms: 1 };
  }) as unknown as typeof safeFetch;
  return { fetch, asked };
};

describe("readSitemap", () => {
  it("reads an index that lists more children than fit in one call, and follows the first 50", async () => {
    const index = `<sitemapindex>${Array.from({ length: 200_000 }, (_, i) => `<sitemap><loc>https://x.co/${i}</loc></sitemap>`).join("")}</sitemapindex>`;
    const child = "<urlset><url><loc>https://x.co/page</loc></url></urlset>";
    const { fetch, asked } = site({ "https://x.co/robots.txt": "Sitemap: https://x.co/index.xml", "https://x.co/index.xml": index, "https://x.co/0": child });
    const read = await readSitemap("x.co", fetch);
    expect(read).toMatchObject({ ok: true, total: 1, pages: [{ loc: "https://x.co/page" }] });
    expect(asked).toHaveLength(52);
  });
});
