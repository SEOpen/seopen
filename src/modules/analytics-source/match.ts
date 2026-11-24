/**
 * Which Analytics source a new project starts on, and which of its sites or projects is picked.
 * A project gets its Analytics from one source at a time (GA4, PostHog, Plausible or Umami), so the new
 * project form shows one switch and the chosen source's list. Pure, so it's unit-tested.
 */
import { bareDomain, scoreGa4Match, type Ga4Property } from "@/modules/google/matching";

export const ANALYTICS_SOURCES = ["GA4", "PostHog", "Plausible", "Umami"] as const;
export type AnalyticsSource = (typeof ANALYTICS_SOURCES)[number];

export const isAnalyticsSource = (v: unknown): v is AnalyticsSource => typeof v === "string" && (ANALYTICS_SOURCES as readonly string[]).includes(v);

/** The form field each source's choice is sent in, the same names its own Analytics page uses. */
export const SOURCE_FIELD: Record<AnalyticsSource, "ga4Property" | "posthogProject" | "plausibleSite" | "umamiSite"> = {
  GA4: "ga4Property",
  PostHog: "posthogProject",
  Plausible: "plausibleSite",
  Umami: "umamiSite",
};

export interface PosthogChoice {
  /** PostHog's numeric project id, as a string, which is what a project stores. */
  id: string;
  name: string;
}

export interface PlausibleChoice {
  /** The site's domain as added to Plausible, which is also its site id. */
  domain: string;
}

export interface UmamiChoice {
  /** Umami's website ID, a UUID, which is what a project stores. */
  id: string;
  name: string;
  domain: string;
}

/** Plausible names a site by its domain, so a match is exact (100) or a subdomain either way (70). Umami websites carry a domain too, and score the same. */
export function scorePlausibleSite(projectDomain: string, site: Pick<PlausibleChoice, "domain">): number {
  const want = bareDomain(projectDomain);
  const have = bareDomain(site.domain);
  if (!want || !have) return 0;
  if (have === want) return 100;
  if (have.endsWith(`.${want}`) || want.endsWith(`.${have}`)) return 70;
  return 0;
}

/**
 * PostHog projects carry only a name, so a match is a guess from it: the whole address (50) or its
 * first label as a word (30), the same weights GA4 gives a property name.
 */
export function scorePosthogProject(projectDomain: string, project: PosthogChoice): number {
  const want = bareDomain(projectDomain);
  const name = project.name.toLowerCase();
  if (!want) return 0;
  if (name.includes(want)) return 50;
  const label = want.split(".")[0];
  if (label.length >= 4 && new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(name)) return 30;
  return 0;
}

export interface SourceLists {
  ga4?: Ga4Property[];
  posthog?: PosthogChoice[];
  plausible?: PlausibleChoice[];
  umami?: UmamiChoice[];
}

export interface SourceMatch {
  source: AnalyticsSource;
  /** What the source's list starts on: a GA4 property, a PostHog project id, a Plausible domain or an Umami website id. */
  value: string;
  score: number;
}

/** Each source's best match for the address, or null where its list has none. */
export function sourceMatches(projectDomain: string, lists: SourceLists): Record<AnalyticsSource, SourceMatch | null> {
  const best = <T>(source: AnalyticsSource, items: T[] | undefined, score: (x: T) => number, value: (x: T) => string): SourceMatch | null => {
    let top: SourceMatch | null = null;
    for (const item of items ?? []) {
      const s = score(item);
      if (s > 0 && (!top || s > top.score)) top = { source, value: value(item), score: s };
    }
    return top;
  };
  return {
    GA4: best("GA4", lists.ga4, (p) => scoreGa4Match(projectDomain, p), (p) => p.property),
    PostHog: best("PostHog", lists.posthog, (p) => scorePosthogProject(projectDomain, p), (p) => p.id),
    Plausible: best("Plausible", lists.plausible, (s) => scorePlausibleSite(projectDomain, s), (s) => s.domain),
    Umami: best("Umami", lists.umami, (s) => scorePlausibleSite(projectDomain, s), (s) => s.id),
  };
}

export interface ChosenLinks {
  gscProperty: string;
  /** Empty unless the switch was on GA4. */
  ga4Property: string;
  /** The PostHog project, Plausible site or Umami website to link, when the switch was on one of them and something was picked. */
  other: { source: Exclude<AnalyticsSource, "GA4">; value: string } | null;
}

/**
 * What the new project form asks to link. Only the field of the source the switch was on counts, so
 * a stale value from another source is never linked; a form with no switch value is GA4.
 */
export function chosenLinks(form: FormData): ChosenLinks {
  const raw = form.get("analyticsSource");
  const source: AnalyticsSource = isAnalyticsSource(raw) ? raw : "GA4";
  const field = (name: string) => String(form.get(name) ?? "").trim();
  const value = source === "GA4" ? "" : field(SOURCE_FIELD[source]);
  return {
    gscProperty: field("gscProperty"),
    ga4Property: source === "GA4" ? field("ga4Property") : "",
    other: source !== "GA4" && value ? { source, value } : null,
  };
}

/**
 * The source the switch starts on: the strongest match, GA4 first on a tie (it's what most sites
 * have), then the first source that's connected, then the first one offered.
 */
export function startingSource(offered: AnalyticsSource[], connected: AnalyticsSource[], matches: Record<AnalyticsSource, SourceMatch | null>): AnalyticsSource | null {
  let top: SourceMatch | null = null;
  for (const source of offered) {
    const m = matches[source];
    if (m && (!top || m.score > top.score)) top = m;
  }
  return top?.source ?? offered.find((s) => connected.includes(s)) ?? offered[0] ?? null;
}
