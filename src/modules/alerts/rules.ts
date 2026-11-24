/**
 * The alert rules. Each is on by default and can be turned
 * off per project. Urgent rules email as soon as they fire, even if the day's email already went;
 * the rest wait for the day's email. No thresholds: each rule says exactly what it checks.
 */

export const ALERT_RULES = ["page-broken", "bot-blocked", "left-top-10"] as const;
export type AlertRule = (typeof ALERT_RULES)[number];

export interface RuleInfo {
  id: AlertRule;
  label: string;
  /** What it checks and where the data comes from, for the Alerts page and MCP. */
  description: string;
  urgent: boolean;
  /** The check that finds it, as an alert names its source. */
  source: string;
}

export const RULES: Record<AlertRule, RuleInfo> = {
  "page-broken": {
    id: "page-broken",
    label: "A page with clicks breaks",
    description: "A page that got Search Console clicks in the last 28 days answers 4xx or 5xx, or is set to noindex, in a site audit crawl.",
    urgent: true,
    source: "Site audit crawl",
  },
  "bot-blocked": {
    id: "bot-blocked",
    label: "A search bot is newly blocked",
    description: "The live robots.txt blocks a search crawler from the home page or a key page that the previous crawl's check found open. Read when a site audit crawl finishes.",
    urgent: true,
    source: "Site audit crawl",
  },
  "left-top-10": {
    id: "left-top-10",
    label: "A tracked keyword leaves the top 10",
    description: "A tracked keyword in the top 10 at its previous check is below 10 or not found. Positions no look could confirm are left out. Sent in the day's email.",
    urgent: false,
    source: "Rank check",
  },
};

export const isAlertRule = (v: unknown): v is AlertRule => typeof v === "string" && (ALERT_RULES as readonly string[]).includes(v);
