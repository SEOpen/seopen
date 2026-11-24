/**
 * What a research form's button says once the form differs from what the page loaded. The server works
 * out finished labels for every case and the browser only picks one, so no dollar figure leaves the server.
 * Client-safe: no database or API here.
 */

import { adsAccepts } from "@/lib/dataforseo/place-names";

export type LookupQuote =
  /** One price whatever is typed. */
  | { kind: "flat"; label: string }
  /** Keyword research: search operators cost more, and a city adds its search volume unless Google Ads refuses the phrase. */
  | { kind: "keyword"; plain: string; operators: string; city: string; cityOperators: string }
  /** Keyword gap: your domain and each competitor at the chosen keywords per domain. `byLimit[limit][n]` prices n domains. */
  | { kind: "keywordGap"; byLimit: Record<string, string[]> }
  /** Link gap: one lookup per competitor, and your own domain isn't one. `byCount[n]` prices n competitors. */
  | { kind: "linkGap"; byCount: string[] };

/** Search operators such as `site:` or `intitle:`. SERP tasks that use them bill at 5× the normal rate. */
export function hasSearchOperators(keyword: string): boolean {
  return /\b\w+:/.test(keyword);
}

/**
 * The domains typed into a `vs` field. Lighter than the server's clean-up, so it can only count too many,
 * and these prices are ceilings.
 */
function typedDomains(fields: URLSearchParams, you: string): string[] {
  return fields
    .getAll("vs")
    .flatMap((s) => s.split(/[\s,]+/))
    .map((s) => s.toLowerCase())
    .filter((d) => d && d !== you);
}

/** The label for `n`, or the last one for more than the page will look up: it stops at its limit. */
const nth = (labels: string[], n: number) => labels[Math.min(n, labels.length - 1)] ?? "";

/** The price of submitting the form as it now stands. `fields` is the form's current values. */
export function quoteLabel(quote: LookupQuote, fields: URLSearchParams): string {
  switch (quote.kind) {
    case "flat":
      return quote.label;
    case "keyword": {
      const q = fields.get("q") ?? "";
      const city = fields.get("city") ?? "";
      const withCity = city !== "" && city !== "0" && adsAccepts(q);
      if (hasSearchOperators(q)) return withCity ? quote.cityOperators : quote.operators;
      return withCity ? quote.city : quote.plain;
    }
    case "keywordGap": {
      const you = (fields.get("q") ?? "").trim().toLowerCase();
      const labels = quote.byLimit[fields.get("limit") ?? ""] ?? Object.values(quote.byLimit).at(-1) ?? [];
      return nth(labels, (you ? 1 : 0) + new Set(typedDomains(fields, you)).size);
    }
    case "linkGap":
      return nth(quote.byCount, typedDomains(fields, (fields.get("q") ?? "").toLowerCase()).length);
  }
}
