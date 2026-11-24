export interface MissingPage {
  message: string;
  back: { href: string; label: string };
}

const INSIDE_A_PROJECT: readonly { path: RegExp; thing: string; href: string; label: string }[] = [
  { path: /^\/rank\/[^/]+/, thing: "keyword", href: "/rank", label: "Back to Rankings" },
  { path: /^\/local\/[^/]+/, thing: "business", href: "/local", label: "Back to Local SEO" },
  { path: /^\/ai\/prompts\/[^/]+/, thing: "prompt", href: "/ai/prompts", label: "Back to Prompts" },
  { path: /^\/audit\/issues\/[^/]+/, thing: "issue", href: "/audit", label: "Back to Site audit" },
  { path: /^\/keywords\/lists\/[^/]+/, thing: "list", href: "/keywords/lists", label: "Back to Keyword lists" },
];

/** What wasn't found inside the app, in words for that address, and the nearest page that's there. Pure. */
export function missingPage(pathname: string): MissingPage {
  if (/^\/projects\/[^/]+/.test(pathname)) {
    return { message: "This project isn't in your workspace. It may have been deleted, or the link may be wrong.", back: { href: "/", label: "All projects" } };
  }
  const known = INSIDE_A_PROJECT.find((p) => p.path.test(pathname));
  if (known) {
    return { message: `This ${known.thing} isn't in the current project. It may have been removed, or it may belong to another project.`, back: { href: known.href, label: known.label } };
  }
  return { message: "This page isn't here. It may have moved, or the link may be wrong.", back: { href: "/", label: "Back to Overview" } };
}
