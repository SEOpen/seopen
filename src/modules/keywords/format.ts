/** Shared display helpers for the keywords and domains modules (safe in client components). */

import { rules } from "@/plan-policy/rules";

/** A Run button's price: research credits on the hosted service ("≈ 2 credits"), dollars on a copy without plans ("≈ $0.02"). */
export const costLabel = (usd: number) => rules.costLabel(usd);

/** The same price as a ceiling, for a lookup where some of it may be saved or fewer rows may come back: "≈ 8 credits max". */
export function maxCostLabel(usd: number) {
  return usd > 0 ? `${costLabel(usd)} max` : costLabel(usd);
}

export const INTENT_TONE = {
  informational: "accent",
  navigational: "neutral",
  commercial: "warn",
  transactional: "good",
} as const;

export type Intent = keyof typeof INTENT_TONE;

export const INTENT_SHORT: Record<string, string> = { informational: "Info", navigational: "Nav", commercial: "Comm", transactional: "Trans" };

export function intentTone(intent: string | null | undefined) {
  return (intent && INTENT_TONE[intent as Intent]) || "neutral";
}

export function kdClass(kd: number) {
  return kd < 30 ? "text-secondary" : kd < 60 ? "text-warn" : "text-bad";
}

/** What a difficulty score means in words, so its colour is never alone. */
export function kdLabel(kd: number) {
  return kd < 15 ? "Very easy" : kd < 30 ? "Easy" : kd < 50 ? "Possible" : kd < 70 ? "Hard" : "Very hard";
}

const IDEA_MODE_TEXT: Record<string, string> = { suggestions: "suggestions", related: "related searches", questions: "questions" };

/**
 * Human-readable "Added from" for a saved keyword. Source ids are written by the grids that save
 * keywords: "ideas:<mode>:<seed>", "domain:<domain>", "gap:<domain>,<domain>,…", or free text
 * such as "keyword overview".
 */
export function sourceLabel(source: string | null | undefined): string | null {
  const s = source?.trim();
  if (!s) return null;
  const [kind, ...restParts] = s.split(":");
  const rest = restParts.join(":");
  if (kind === "ideas" && rest) {
    const i = rest.indexOf(":");
    const mode = i < 0 ? rest : rest.slice(0, i);
    const seed = i < 0 ? "" : rest.slice(i + 1).trim();
    const what = IDEA_MODE_TEXT[mode] ?? mode;
    return seed ? `Keyword ideas · ${what} for “${seed}”` : `Keyword ideas · ${what}`;
  }
  if (kind === "domain" && rest) return `Domain keywords · ${rest}`;
  if (kind === "gap" && rest) return `Keyword gap · ${rest.split(",").filter(Boolean).join(" vs ")}`;
  if (s === "keyword overview") return "Keyword overview";
  return s;
}

/** A volume column's name, with the place its volumes are for, so a country's number can't pass for a city's. */
export function searchesIn(place: string): string {
  return `Searches a month in ${place}`;
}
