import { attributes, elements, openTags } from "@/lib/web/html";

/**
 * DataForSEO's duplicate_meta_tags fires when any meta tag repeats, which includes pairs that are
 * meant to repeat, such as theme-color for light and dark mode. Our finding is narrower: two
 * titles or two descriptions, where a search engine has to pick one. These count those in the
 * page's head, for the audit's confirmation fetch and the fix's live check alike.
 */
export function headOf(html: string): string {
  return elements(html, ["head"], 1)[0]?.inner ?? html;
}

export function titleAndDescriptionCounts(html: string): { titles: number; descriptions: number } {
  const head = headOf(html);
  const titles = [...head.matchAll(/<title\b/gi)].length;
  const descriptions = openTags(head, "meta").filter((t) => attributes(t.raw).name?.toLowerCase() === "description").length;
  return { titles, descriptions };
}

/** True when the page really has more than one title or description tag. */
export function hasDuplicateTitleOrDescription(html: string): boolean {
  const { titles, descriptions } = titleAndDescriptionCounts(html);
  return titles > 1 || descriptions > 1;
}
