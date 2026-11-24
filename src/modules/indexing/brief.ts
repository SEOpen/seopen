import type { FigureData } from "@/components/ui/figure";
import { formatNumber } from "@/lib/format";
import type { IndexingView } from "./data";

const value = (id: string, label: string, n: number, caption: string): FigureData => ({ id, label, state: "value", value: formatNumber(n), delta: null, caption });

const pages = (n: number) => `${formatNumber(n)} ${n === 1 ? "page" : "pages"}`;

/** The Indexing tab's sentence: what Google hasn't indexed, and what to do first. */
export function indexingSentence(v: IndexingView): string {
  const { counts: c } = v;
  if (!c.pages) return v.settings?.sitemapError ? "No sitemap pages to check yet." : "The first check reads the sitemap, then asks Google about each page.";
  if (!c.inspected) return `Found ${pages(c.pages)} in the sitemap. Google's answers arrive over the next runs, a few hundred pages a day.`;
  const left = c.unchecked ? ` ${pages(c.unchecked)} still to check.` : "";
  if (!c.notIndexed) return `Google has indexed every page checked so far, ${formatNumber(c.indexed)} of ${formatNumber(c.pages)}.${left}`;
  const all = c.requestIndexing === c.notIndexed;
  const ask = !c.requestIndexing
    ? ""
    : all
      ? ` ${c.notIndexed === 1 ? "It's" : "Each is"} known to Google, so a Request Indexing in Search Console should help.`
      : ` ${c.requestIndexing === 1 ? "One is" : `${formatNumber(c.requestIndexing)} are`} worth a Request Indexing in Search Console.`;
  return `Google hasn't indexed ${pages(c.notIndexed)} from the sitemap.${ask}${left}`;
}

export function indexingFigures(v: IndexingView): FigureData[] {
  const { counts: c } = v;
  if (!c.pages) return [];
  return [
    value("pages", "Sitemap pages", c.pages, "Read from the site's sitemap"),
    value("indexed", "Indexed", c.indexed, `Of ${formatNumber(c.inspected)} checked`),
    value("not-indexed", "Not indexed", c.notIndexed, "As Google last answered"),
    value("request", "Request indexing", c.requestIndexing, "Known to Google, not indexed"),
  ];
}
