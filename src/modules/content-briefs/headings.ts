import { decodeEntities, elements, stripComments, stripTags, withoutElements } from "@/lib/web/html";
import type { Heading, OutlineItem } from "./types";

/** Most headings kept per page. */
export const MAX_HEADINGS = 25;
const MAX_TEXT = 150;

/** Text from the web, as one plain line: control characters out, spaces folded, cut to `max`. */
export function plainLine(s: string, max = MAX_TEXT): string {
  const line = s
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** A page's H1 to H3 headings in order, without the ones inside nav, header, footer and aside, or the comment form's and sidebar's ("Leave a Reply", "Related Posts"). */
export function pageHeadings(html: string): Heading[] {
  const body = withoutElements(stripComments(html), ["script", "style", "noscript", "template", "svg", "nav", "header", "footer", "aside"]);
  const out: Heading[] = [];
  for (const el of elements(body, ["h1", "h2", "h3"])) {
    const text = plainLine(decodeEntities(stripTags(el.inner)));
    if (!text || FURNITURE.test(text)) continue;
    out.push({ level: Number(el.name.slice(1)) as 1 | 2 | 3, text });
    if (out.length >= MAX_HEADINGS) break;
  }
  return out;
}

/** Headings that are page furniture, not what the page covers. */
const FURNITURE = /^(related( posts| articles)?|you may also like|more from|recent posts|popular posts|comments?|leave a (reply|comment)|share( this)?|subscribe|newsletter|sign up|table of contents|contents|about the author|author|follow us|categories|tags|search|menu|footer|navigation)\b/i;

const key = (text: string) =>
  text
    .toLowerCase()
    .replace(/^\s*(\d+[.):]?|step \d+:?)\s*/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * H2 and H3 headings that at least `min` of the pages share (same words, ignoring numbering and
 * punctuation), most shared first, in the first page's wording.
 */
export function sharedHeadings(pages: Heading[][], min = 2, limit = 6): { text: string; pages: number }[] {
  const seen = new Map<string, { text: string; pages: Set<number>; first: number }>();
  let order = 0;
  pages.forEach((headings, i) => {
    for (const h of headings) {
      if (h.level === 1 || FURNITURE.test(h.text)) continue;
      const k = key(h.text);
      if (k.length < 3) continue;
      const entry = seen.get(k) ?? { text: h.text, pages: new Set<number>(), first: order++ };
      entry.pages.add(i);
      seen.set(k, entry);
    }
  });
  return [...seen.values()]
    .filter((e) => e.pages.size >= min)
    .sort((a, b) => b.pages.size - a.pages.size || a.first - b.first)
    .slice(0, limit)
    .map((e) => ({ text: e.text, pages: e.pages.size }));
}

/**
 * How far in to show each of a page's headings, 0 for the outermost. A heading sits one step inside
 * the nearest higher-level heading before it, so a page that goes H1 then H3 shows the H3 one step
 * in, not two, and a page that opens with an H3 starts it at 0. The levels stay as the page has them.
 */
export function headingDepths(headings: Heading[]): number[] {
  const open: number[] = [];
  return headings.map((h) => {
    while (open.length && open[open.length - 1] >= h.level) open.pop();
    open.push(h.level);
    return open.length - 1;
  });
}

/** A suggested outline with no H3 before the first H2: such an H3 has nothing to sit under, so it becomes an H2. */
export function nestOutline(items: OutlineItem[]): OutlineItem[] {
  let underH2 = false;
  return items.map((h) => {
    if (h.level === 2) underH2 = true;
    return h.level === 3 && !underH2 ? { ...h, level: 2 } : h;
  });
}
