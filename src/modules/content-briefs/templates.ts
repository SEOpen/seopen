import type { BriefFill, BriefOption, ContentBrief, OutlineItem, OwnerInput, PageType } from "./types";

/**
 * Page-type templates and their rules. Pure, so the create form, the fill form, the MCP tool and the
 * Markdown export all hold the same rules:
 * - X vs Y needs two different things to compare; Y defaults to a tracked competitor.
 * - X alternatives lists 5 to 8 options, never the site itself first, one real drawback each.
 * - Best X for Y needs both X and Y, and never puts the site itself first either.
 * - Every price needs the date it was checked on the vendor's page.
 */

export const OPTION_RANGE = { min: 5, max: 8 } as const;
export const MAX_MERGED = 10;
export const FIELD_MAX = { subject: 120, angle: 2000, input: 4000, optionName: 120, url: 2000, price: 120, drawback: 1000 } as const;

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** X and Y read off the keyword when it's phrased as the template: "notion vs obsidian", "best crm for startups". */
export function subjectsFromKeyword(pageType: PageType, keyword: string): { x: string | null; y: string | null } {
  const k = clean(keyword).toLowerCase();
  const pick = (re: RegExp): RegExpMatchArray | null => k.match(re);
  if (pageType === "vs") {
    const m = pick(/^(.+?)\s+(?:vs\.?|versus|or)\s+(.+)$/);
    return m ? { x: m[1], y: m[2] } : { x: null, y: null };
  }
  if (pageType === "alternatives") {
    const m = pick(/^(?:best\s+|top\s+)?(.+?)\s+alternatives?(?:\s.*)?$/) ?? pick(/^alternatives?\s+(?:to\s+)?(.+)$/);
    return { x: m ? m[1] : null, y: null };
  }
  if (pageType === "best") {
    const m = pick(/^(?:the\s+)?best\s+(.+?)\s+for\s+(.+)$/);
    return m ? { x: m[1], y: m[2] } : { x: null, y: null };
  }
  if (pageType === "pricing") {
    const m = pick(/^(.+?)\s+(?:pricing|prices?|cost|plans)(?:\s.*)?$/) ?? pick(/^how much (?:is|does)\s+(.+?)(?:\s+cost)?$/);
    return { x: m ? m[1] : null, y: null };
  }
  return { x: null, y: null };
}

export interface TemplateInput {
  pageType: PageType;
  keyword: string;
  x?: string | null;
  y?: string | null;
  /** Tracked competitor domains, for prefilling. */
  competitors: string[];
  /** The project's name and domain, so the site isn't put up as its own rival. */
  own: { name: string; domain: string };
}

/** X and Y for the template, from what was given, then the keyword, then (for Y on a vs page) a tracked competitor. */
export function resolveSubjects(input: TemplateInput): { x: string | null; y: string | null } {
  const parsed = subjectsFromKeyword(input.pageType, input.keyword);
  let x = clean(input.x) || parsed.x;
  let y = clean(input.y) || parsed.y;
  if (input.pageType === "vs") {
    x ||= input.own.name;
    if (!y) y = input.competitors.find((c) => !isOwn(c, input.own)) ?? null;
  }
  if (input.pageType === "guide") x = y = null;
  if (input.pageType === "alternatives" || input.pageType === "pricing") y = null;
  return { x: x || null, y: y || null };
}

/** Problems with the template's subjects, before anything is looked up. */
export function subjectProblems(pageType: PageType, s: { x: string | null; y: string | null }): string[] {
  const out: string[] = [];
  const long = (v: string | null) => !!v && v.length > FIELD_MAX.subject;
  if (long(s.x) || long(s.y)) out.push(`Keep each name to ${FIELD_MAX.subject} characters.`);
  if (pageType === "vs") {
    if (!s.x || !s.y) out.push("An X vs Y page needs both names. Give Y, or add a competitor to the project.");
    else if (s.x.toLowerCase() === s.y.toLowerCase()) out.push("X and Y are the same, so there's nothing to compare.");
  }
  if (pageType === "alternatives" && !s.x) out.push("Say what the alternatives are to (X).");
  if (pageType === "best" && (!s.x || !s.y)) out.push("A Best X for Y page needs what's being picked (X) and who it's for (Y).");
  if (pageType === "pricing" && !s.x) out.push("Say whose pricing the page covers (X).");
  return out;
}

const host = (url: string | null | undefined) => {
  if (!url) return "";
  try {
    return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** Whether an option (a name, a domain or a URL) is the site itself. */
export function isOwn(nameOrUrl: string | null | undefined, own: { name: string; domain: string }, url?: string | null): boolean {
  const domain = own.domain.toLowerCase().replace(/^www\./, "");
  const match = (h: string) => !!h && (h === domain || h.endsWith(`.${domain}`));
  const n = clean(nameOrUrl).toLowerCase();
  return match(host(url)) || match(host(n)) || (!!n && (n === own.name.toLowerCase() || n === domain));
}

/** Pages whose rules count options. */
export const usesOptions = (pageType: PageType) => pageType === "alternatives" || pageType === "best" || pageType === "vs";

/** Options proposed for a new brief: tracked competitors first, then other sites ranking in the top 10, never the site itself, at most 8. */
export function proposeOptions(pageType: PageType, s: { x: string | null; y: string | null }, competitors: string[], serpDomains: string[], own: { name: string; domain: string }): BriefOption[] {
  const blank = (name: string, url: string | null): BriefOption => ({ name, url, price: null, priceCheckedOn: null, drawback: null });
  if (pageType === "vs") return [s.x, s.y].filter((v): v is string => !!v).map((v) => blank(v, isOwn(v, own) ? `https://${own.domain}/` : null));
  if (!usesOptions(pageType)) return [];
  const x = (s.x ?? "").toLowerCase();
  const seen = new Set<string>();
  const out: BriefOption[] = [];
  for (const d of [...competitors, ...serpDomains]) {
    const domain = d.toLowerCase().replace(/^www\./, "");
    if (!domain || seen.has(domain) || isOwn(domain, own) || (x && domain.startsWith(`${x.replace(/\s+/g, "")}.`)) || NOT_VENDORS.test(domain)) continue;
    seen.add(domain);
    out.push(blank(domain, `https://${domain}/`));
    if (out.length >= OPTION_RANGE.max) break;
  }
  return out;
}

/** Sites in a top 10 that are places to read about options, not options. */
const NOT_VENDORS = /(^|\.)(reddit|quora|youtube|wikipedia|medium|g2|capterra|trustpilot|forbes|linkedin|facebook|x|twitter|pcmag|techradar|zapier|getapp|softwareadvice)\.(com|org)$/;

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));

/**
 * Rule breaks in a list of options, for saving it: each blocks the save. `today` is YYYY-MM-DD, so a
 * checked-on date in the future is refused.
 */
export function optionProblems(pageType: PageType, options: BriefOption[], own: { name: string; domain: string }, today: string): string[] {
  const out: string[] = [];
  const named = options.filter((o) => clean(o.name));
  if (pageType === "alternatives" && (named.length < OPTION_RANGE.min || named.length > OPTION_RANGE.max)) {
    out.push(`An alternatives page lists ${OPTION_RANGE.min} to ${OPTION_RANGE.max} options; this has ${named.length}.`);
  }
  if (pageType === "best" && named.length > OPTION_RANGE.max) out.push(`List at most ${OPTION_RANGE.max} options.`);
  if ((pageType === "alternatives" || pageType === "best") && named[0] && isOwn(named[0].name, own, named[0].url)) {
    out.push("Don't rank your own site first. Move it down the list.");
  }
  const names = new Set<string>();
  named.forEach((o, i) => {
    const label = `Option ${i + 1} (${clean(o.name)})`;
    const key = clean(o.name).toLowerCase();
    if (names.has(key)) out.push(`${label} is listed twice.`);
    names.add(key);
    if (clean(o.name).length > FIELD_MAX.optionName) out.push(`${label}: keep the name to ${FIELD_MAX.optionName} characters.`);
    if (clean(o.price)) {
      const on = clean(o.priceCheckedOn);
      if (!on) out.push(`${label} has a price but no checked-on date. Add the date you read it on their pricing page.`);
      else if (!isDay(on)) out.push(`${label}: the checked-on date should be a date, such as ${today}.`);
      else if (on > today) out.push(`${label}: the checked-on date is in the future.`);
    }
    if (clean(o.drawback).length > FIELD_MAX.drawback) out.push(`${label}: keep the drawback to ${FIELD_MAX.drawback} characters.`);
  });
  return out;
}

/** The 3 to 5 things only the owner can supply. Each is required and starts "to fill". */
export function ownerInputs(pageType: PageType, s: { x: string | null; y: string | null }): OwnerInput[] {
  const numbers: OwnerInput = { id: "numbers", prompt: "Your own numbers: a figure from your own work, customers or data on this topic, and where it comes from." };
  const test: OwnerInput = { id: "test", prompt: "A test you ran: what you did, how long for, and what happened." };
  const shots: OwnerInput = { id: "screenshots", prompt: "Screenshots of the real thing: your product, your setup or your results. List what each one shows." };
  const prices: OwnerInput = { id: "prices", prompt: "Real prices, each with the date you checked it on the vendor's own pricing page." };
  const drawback: OwnerInput = { id: "drawback", prompt: `One real drawback${pageType === "guide" ? " or limit of the approach" : s.x ? ` of ${s.x}` : ""}, said plainly.` };
  if (pageType === "guide") return [numbers, test, shots, drawback];
  return [numbers, test, shots, prices, drawback];
}

/** The template's own headings. Only names and placeholders, no claims. */
export function templateHeadings(pageType: PageType, s: { x: string | null; y: string | null }, options: BriefOption[]): OutlineItem[] {
  const h2 = (text: string): OutlineItem => ({ level: 2, text, from: "Page type" });
  const h3 = (text: string): OutlineItem => ({ level: 3, text, from: "Page type" });
  const x = s.x ?? "X";
  const y = s.y ?? "Y";
  switch (pageType) {
    case "vs":
      return [h2(`${x} vs ${y} at a glance`), h2("Pricing, checked on [date]"), h2(`Where ${x} is the better pick`), h2(`Where ${y} is the better pick`), h2("What we found when we tried both"), h2(`Who should choose ${x}, and who should choose ${y}`)];
    case "alternatives":
      return [
        h2(`Why people look for an alternative to ${x}`),
        h2("How we picked these"),
        ...options.flatMap((o, i) => [h2(`${i + 1}. ${o.name || "[option]"}`), h3("Price, checked on [date]"), h3("The drawback")]),
        h2(`${x} alternatives side by side`),
      ];
    case "best":
      return [h2(`What matters in ${x} for ${y}`), h2("How we picked"), ...options.flatMap((o, i) => [h2(`${i + 1}. ${o.name || "[option]"}`), h3("Who it suits"), h3("The drawback")]), h2("Side by side")];
    case "pricing":
      return [h2(`${x} pricing at a glance, checked on [date]`), h2("What each plan includes"), h2("Costs that aren't on the pricing page"), h2("What we pay, and what we got for it"), h2(`Is ${x} worth the price?`), h2("Cheaper options")];
    default:
      return [h2("What we found when we tried it"), h2("Mistakes to avoid"), h2("Limits and drawbacks")];
  }
}

/** Everything still marked "to fill", as plain lines. An empty list means the brief is ready to write from. */
export function toFill(brief: ContentBrief, fill: BriefFill): string[] {
  const out: string[] = [];
  if (!clean(fill.angle)) out.push("The angle the top 3 all miss");
  for (const input of brief.ownerInputs) if (!clean(fill.inputs?.[input.id])) out.push(input.prompt.split(":")[0]);
  const pageType = brief.template.pageType;
  const options = fill.options ?? brief.options;
  const named = options.filter((o) => clean(o.name));
  if (pageType === "alternatives" && named.length < OPTION_RANGE.min) out.push(`${OPTION_RANGE.min - named.length} more option${OPTION_RANGE.min - named.length === 1 ? "" : "s"} (${OPTION_RANGE.min} to ${OPTION_RANGE.max})`);
  if (usesOptions(pageType)) {
    for (const o of named) if (!clean(o.drawback)) out.push(`A real drawback of ${clean(o.name)}`);
  }
  return out;
}

/** The page type a keyword reads as, for the create form's first guess. The owner can change it. */
export function guessPageType(keyword: string): PageType {
  const k = clean(keyword).toLowerCase();
  if (/\s(vs\.?|versus)\s/.test(k)) return "vs";
  if (/\balternatives?\b/.test(k)) return "alternatives";
  if (/^(the\s+)?best\s+.+\s+for\s+.+/.test(k)) return "best";
  if (/\b(pricing|prices?|cost|plans)\b/.test(k) && subjectsFromKeyword("pricing", k).x) return "pricing";
  return "guide";
}
