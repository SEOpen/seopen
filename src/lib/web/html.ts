/**
 * What a crawler that doesn't run JavaScript sees in a page's HTML: its title, robots directives,
 * structured data, headings and how much readable text arrives without scripts. Regex-based on
 * purpose (no DOM dependency on the server); it reads the parts crawlers read, not every edge of
 * HTML. Pure functions, no I/O.
 *
 * The HTML comes from any site a visitor names, so nothing here may take more than linear time on
 * hostile markup. A lazy regex like `<script\b[^>]*>([\s\S]*?)<\/script>` rescans to the
 * end of the page from every opener that has no closer, so 200 KB of unclosed tags took seconds.
 * Elements, tags and comments are found with the scanners below instead, which stop once nothing
 * later can match.
 */

export interface PageFacts {
  title: string | null;
  description: string | null;
  lang: string | null;
  canonical: string | null;
  /** Lowercased directives from <meta name="robots|googlebot"> and X-Robots-Tag. */
  robots: string[];
  h1: number;
  h2: number;
  /** Words of visible text in the raw HTML (scripts, styles and markup removed). */
  words: number;
  /** An app shell: an empty mount point and almost no text, so the content needs JavaScript. */
  jsShell: boolean;
  /** schema.org types in JSON-LD, plus any microdata itemtypes. */
  schemaTypes: string[];
  jsonLdBlocks: number;
  jsonLdErrors: number;
  /** A "noai" or "noimageai" directive (not a standard; some CMSs and CDNs add it). */
  hasNoAi: boolean;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", middot: "·", bull: "•",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", times: "×",
};

/** A numeric entity's character. As in HTML, U+FFFD for a number that isn't one: 0, a surrogate, or past the last code point. */
function codePoint(n: number): string {
  return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? "\ufffd" : String.fromCodePoint(n);
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
    const lower = e.toLowerCase();
    if (lower.startsWith("#x")) return codePoint(parseInt(lower.slice(2), 16));
    if (lower.startsWith("#")) return codePoint(parseInt(lower.slice(1), 10));
    return Object.hasOwn(ENTITIES, lower) ? ENTITIES[lower] : m;
  });
}

/**
 * Attributes of one tag: `<meta name="x" content='y'>` → { name: "x", content: "y" }. A name starts
 * where the run of name characters starts, so a long run without "=" is read once, not from each of its characters.
 */
export function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/(?<![-a-zA-Z0-9_:.])([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return out;
}

/** "max-snippet : 50" → "max-snippet:50", at the first colon. Cut by position: a pattern for the spaces around it rescans a long run of them. */
function tightColon(directive: string): string {
  const colon = directive.indexOf(":");
  return colon < 0 ? directive : `${directive.slice(0, colon).trimEnd()}:${directive.slice(colon + 1).trimStart()}`;
}

/** Directives with a value after a colon, which aren't a user-agent prefix. */
const VALUE_DIRECTIVES = new Set(["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"]);

/**
 * The X-Robots-Tag directives Google's crawlers obey. "googlebot: noindex, nofollow" applies to
 * Googlebot; "bingbot: noindex" doesn't; a value with no prefix applies to every crawler.
 */
export function xRobotsDirectives(value: string): string[] {
  const out: string[] = [];
  let applies = true;
  for (const raw of value.toLowerCase().split(",")) {
    let part = raw.trim();
    const m = /^([a-z0-9_*-]+)\s*:\s*(.*)$/.exec(part);
    if (m && !VALUE_DIRECTIVES.has(m[1])) {
      applies = m[1] === "googlebot" || m[1] === "*";
      part = m[2].trim();
    }
    if (applies && part) out.push(tightColon(part));
  }
  return out;
}

export interface OpenTag {
  /** The whole opening tag, `<meta name="x">`. */
  raw: string;
  start: number;
  /** Just past its `>`. */
  end: number;
}

/**
 * Every opening tag named `name`, as `<name\b[^>]*>` finds them, in linear time: each opener's `>`
 * is found with indexOf, and with no `>` left no later tag can close, so the scan stops.
 */
export function openTags(html: string, name: string): OpenTag[] {
  const out: OpenTag[] = [];
  const opener = new RegExp(`<${name}\\b`, "gi");
  for (let m = opener.exec(html); m; m = opener.exec(html)) {
    const gt = html.indexOf(">", m.index);
    if (gt < 0) break;
    out.push({ raw: html.slice(m.index, gt + 1), start: m.index, end: gt + 1 });
    opener.lastIndex = gt + 1;
  }
  return out;
}

export interface Element extends OpenTag {
  /** Lowercased tag name. */
  name: string;
  /** What's between the opening tag and `</name>`. */
  inner: string;
}

/**
 * Elements of any of `names`, left to right and not nested, as `<(a|b)\b[^>]*>([\s\S]*?)<\/\1>`
 * finds them, in linear time: a name with no closer left is skipped from then on, and the scan
 * stops when no `>` is left. `end` is just past the closer. At most `limit`.
 */
export function elements(html: string, names: string[], limit = Infinity): Element[] {
  const out: Element[] = [];
  const opener = new RegExp(`<(${names.join("|")})\\b`, "gi");
  const closers = new Map(names.map((n) => [n.toLowerCase(), new RegExp(`</${n}>`, "gi")]));
  const unclosed = new Set<string>();
  for (let m = opener.exec(html); m && out.length < limit; m = opener.exec(html)) {
    const name = m[1].toLowerCase();
    if (unclosed.has(name)) continue;
    const gt = html.indexOf(">", m.index);
    if (gt < 0) break;
    const closer = closers.get(name)!;
    closer.lastIndex = gt + 1;
    const close = closer.exec(html);
    if (!close) {
      unclosed.add(name);
      continue;
    }
    const end = close.index + close[0].length;
    out.push({ name, raw: html.slice(m.index, gt + 1), start: m.index, end, inner: html.slice(gt + 1, close.index) });
    opener.lastIndex = end;
  }
  return out;
}

/** `html` with each [start, end) range replaced by a space. Ranges are in order and don't overlap. */
function cut(html: string, ranges: { start: number; end: number }[]): string {
  if (!ranges.length) return html;
  let out = "";
  let at = 0;
  for (const r of ranges) {
    out += `${html.slice(at, r.start)} `;
    at = r.end;
  }
  return out + html.slice(at);
}

/** Comments removed, as `<!--[\s\S]*?-->` would, with an unclosed one left as it is. */
export function stripComments(html: string): string {
  const ranges: { start: number; end: number }[] = [];
  for (let at = html.indexOf("<!--"); at >= 0; ) {
    const close = html.indexOf("-->", at + 4);
    if (close < 0) break;
    ranges.push({ start: at, end: close + 3 });
    at = html.indexOf("<!--", close + 3);
  }
  return cut(html, ranges);
}

/** `html` with each element of `names` (as `elements` finds them) replaced by a space. An unclosed one is left as it is. */
export function withoutElements(html: string, names: string[]): string {
  return cut(html, elements(html, names));
}

/**
 * Markup replaced by spaces, as `.replace(/<[^>]+>/g, " ")`. Nothing after the last `>` can be a
 * tag, so that part is left alone rather than rescanned from each `<` in it.
 */
export function stripTags(html: string): string {
  const last = html.lastIndexOf(">");
  return last < 0 ? html : html.slice(0, last + 1).replace(/<[^>]+>/g, " ") + html.slice(last + 1);
}

/** The text of each `<script type="application/ld+json">` block. */
export function jsonLdBlocks(html: string): string[] {
  return elements(html, ["script"])
    .filter((e) => /\btype\s*=\s*["']?application\/ld\+json/i.test(e.raw))
    .map((e) => e.inner);
}

const tags = (html: string, name: string) => openTags(html, name).map((t) => attributes(t.raw));

/** Every schema.org @type in a JSON-LD value, @graph and nested entities included. */
export function jsonLdTypes(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) jsonLdTypes(v, out);
  else if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const t = obj["@type"];
    for (const type of Array.isArray(t) ? t : t ? [t] : []) if (typeof type === "string") out.add(type.replace(/^https?:\/\/schema\.org\//, ""));
    for (const [k, v] of Object.entries(obj)) if (k !== "@type" && k !== "@context") jsonLdTypes(v, out);
  }
  return out;
}

/** What's between the first `<body>` and the last `</body>`, or null without both. */
function bodyOf(html: string): string | null {
  const open = openTags(html, "body")[0];
  if (!open) return null;
  let last = -1;
  const closer = /<\/body>/gi;
  closer.lastIndex = open.end;
  for (let m = closer.exec(html); m; m = closer.exec(html)) last = m.index;
  return last < 0 ? null : html.slice(open.end, last);
}

const HIDDEN = ["script", "style", "noscript", "template", "svg", "iframe", "canvas"];

/** Visible text: the body without scripts, styles, templates, SVG and markup. */
export function visibleText(html: string): string {
  let body = bodyOf(html);
  if (body === null) {
    const head = elements(html, ["head"], 1)[0];
    body = head ? cut(html, [head]) : html;
  }
  const uncommented = stripComments(body);
  return decodeEntities(stripTags(cut(uncommented, elements(uncommented, HIDDEN))))
    .replace(/\s+/g, " ")
    .trim();
}

export const wordCount = (text: string) => (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;

/** Markup around a page's own content that every page repeats. */
export const CHROME = ["header", "nav", "footer", "aside"];

/**
 * Words in a page's own content, link text included: the `<main>` element when there is one,
 * otherwise the body without its header, nav, footer and aside. A card grid or a blog index keeps
 * most of its copy inside links, and a count that skips link text calls such a page thin.
 */
export function contentWordCount(html: string): number {
  const uncommented = stripComments(html);
  const main = elements(uncommented, ["main"], 1)[0];
  const content = main ? main.inner : withoutElements(bodyOf(uncommented) ?? uncommented, CHROME);
  return wordCount(visibleText(content));
}

const SHELL_IDS = new Set(["root", "app", "__next", "__nuxt", "svelte", "main-app"]);

/** An empty mount point: `<div id="root"></div>` and its framework cousins. */
function hasShell(html: string): boolean {
  const empty = /\s*<\/div>/iy;
  return openTags(html, "div").some((t) => {
    if (!SHELL_IDS.has((attributes(t.raw).id ?? "").toLowerCase())) return false;
    empty.lastIndex = t.end;
    return empty.test(html);
  });
}

export function pageFacts(html: string, headers: Record<string, string | string[] | undefined> = {}): PageFacts {
  const head = elements(html, ["head"], 1)[0]?.inner ?? html;
  const metas = tags(head, "meta");
  const meta = (name: string) => metas.find((m) => m.name?.toLowerCase() === name)?.content?.trim() || null;

  const robots: string[] = [];
  for (const m of metas) {
    const name = m.name?.toLowerCase();
    if (name !== "robots" && name !== "googlebot") continue;
    // One at a time, so any number fits.
    for (const d of (m.content ?? "").toLowerCase().split(",")) if (d.trim()) robots.push(tightColon(d.trim()));
  }
  const xRobots = headers["x-robots-tag"];
  for (const value of Array.isArray(xRobots) ? xRobots : xRobots ? [xRobots] : []) robots.push(...xRobotsDirectives(value));

  const types = new Set<string>();
  let blocks = 0;
  let errors = 0;
  for (const block of jsonLdBlocks(html)) {
    blocks++;
    try {
      jsonLdTypes(JSON.parse(block.trim()), types);
    } catch {
      errors++;
    }
  }
  for (const m of html.matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)) types.add(m[1]);

  const text = visibleText(html);
  const words = wordCount(text);
  const canonical = tags(head, "link").find((l) => (l.rel ?? "").toLowerCase().split(/\s+/).includes("canonical"))?.href ?? null;
  const title = elements(head, ["title"], 1)[0]?.inner;
  const lang = openTags(html, "html")
    .map((t) => (attributes(t.raw).lang ?? "").trim().split(/\s+/)[0])
    .find(Boolean);

  return {
    title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() || null : null,
    description: meta("description"),
    lang: lang ?? null,
    canonical,
    robots: [...new Set(robots)],
    h1: (html.match(/<h1\b/gi) ?? []).length,
    h2: (html.match(/<h2\b/gi) ?? []).length,
    words,
    jsShell: words < 80 && hasShell(html),
    schemaTypes: [...types].sort(),
    jsonLdBlocks: blocks,
    jsonLdErrors: errors,
    hasNoAi: robots.some((d) => d === "noai" || d === "noimageai"),
  };
}

/** Robots directives that keep a page out of Google's AI Overviews and AI Mode, if any. */
export function snippetBlocks(robots: string[]): string[] {
  return robots.filter((d) => d === "noindex" || d === "none" || d === "nosnippet" || d === "max-snippet:0");
}
