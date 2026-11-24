import { attributes, openTags, stripComments, withoutElements } from "@/lib/web/html";

/**
 * DataForSEO's no_image_alt fires for an image with no alt attribute and for one with alt="",
 * which is right for a decorative image. Our finding is only the first: an `<img>` with no alt
 * attribute at all. These read that from a page's raw HTML, for the audit's confirmation fetch
 * and the fix's live check alike.
 */

/** Images named in a finding's detail. Past this the detail says how many more. */
const NAMED_IMAGES = 3;
const SRC_CHARS = 200;
/** Markup that never renders an `<img>` from its contents: a tag in a script string, a noscript tracking pixel, a template. */
const NOT_RENDERED = ["script", "noscript", "template", "style"];

export interface ImageAltCounts {
  images: number;
  /** How many `<img>` have no alt attribute. */
  missing: number;
  /** The first few of those in page order, labelled for a finding's detail ("/hero.jpg", "an inline image"). */
  named: string[];
}

/** The images with no alt attribute that a finding's detail names. */
export type ImagesWithoutAlt = Pick<ImageAltCounts, "missing" | "named">;

/** Whether a tag has an alt attribute, with a value or bare (`<img alt>` is alt=""). Quoted values are blanked first so `title="no alt"` doesn't count. */
function hasAlt(tag: string): boolean {
  return /\salt(?=[\s/>=]|$)/i.test(tag.replace(/"[^"]*"|'[^']*'/g, '""'));
}

/** Images in commented-out markup, scripts, noscripts, templates and styles don't count: a visitor never sees them. */
export function imageAltCounts(html: string): ImageAltCounts {
  const uncommented = stripComments(html);
  const tags = openTags(withoutElements(uncommented, NOT_RENDERED), "img");
  const missing = tags.filter((t) => !hasAlt(t.raw));
  const named = missing.slice(0, NAMED_IMAGES).map((t) => {
    const a = attributes(t.raw);
    return detach(label(a.src ?? a["data-src"] ?? ""));
  });
  return { images: tags.length, missing: missing.length, named };
}

const label = (src: string) => (!src ? "an image with no src" : src.startsWith("data:") ? "an inline image" : src.length > SRC_CHARS ? `${src.slice(0, SRC_CHARS)}…` : src);

/**
 * A copy of `s` with its own storage. A slice of a string can share the whole string's memory, and
 * the import holds these names for up to 200 pages while it works, so each would pin its page's HTML.
 */
const detach = (s: string) => Buffer.from(s, "utf8").toString("utf8");

/** The detail for a missing-alt finding: "/a.png, /b.png, /c.png, +2 more". */
export function missingAltDetail({ missing, named }: ImagesWithoutAlt): string | null {
  if (!missing) return null;
  const list = named.join(", ");
  return missing > named.length ? `${list}, +${missing - named.length} more` : list;
}
