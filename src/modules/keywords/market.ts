import { LOCATIONS } from "@/lib/dataforseo/locations";
import type { Project } from "@/lib/projects";
import { MAX_KEYWORD_LENGTH, type Market } from "./requests";

/** The market for a research query: `?loc=` when it's a known location, else the project's, else the US. */
export function resolveMarket(loc: string | undefined, project: Pick<Project, "locationCode" | "languageCode"> | null): Market {
  const code = Number(loc);
  if (project && (!loc || code === project.locationCode)) return { locationCode: project.locationCode, languageCode: project.languageCode };
  const known = LOCATIONS.find((l) => l.code === code);
  if (known) return { locationCode: known.code, languageCode: known.languageCode };
  return { locationCode: 2840, languageCode: "en" };
}

/** The keyword from `?q=`, trimmed and lowercased. Over-long input is rejected (q = "") so no paid call is made. */
export function keywordQuery(raw: string | undefined): { q: string; tooLong: boolean } {
  const q = (raw ?? "").trim().toLowerCase();
  return q.length > MAX_KEYWORD_LENGTH ? { q: "", tooLong: true } : { q, tooLong: false };
}

/** A single string from a search param that may be repeated. */
export function param(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Builds "/path?a=1&b=2", skipping empty values. */
export function href(path: string, params: Record<string, string | number | undefined | null>) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const s = qs.toString();
  return s ? `${path}?${s}` : path;
}

/** Sub-navigation for /keywords. Hrefs carry q and loc but never run=1, so switching tabs never spends. */
export function keywordTabs(q: string, loc: number, city?: number) {
  const p = { q, loc, city };
  return [
    { href: href("/keywords", p), label: "Overview" },
    { href: href("/keywords/ideas", p), label: "Ideas" },
    { href: href("/keywords/lists", p), label: "Saved lists" },
    { href: "/keywords/briefs", label: "Briefs" },
  ];
}
