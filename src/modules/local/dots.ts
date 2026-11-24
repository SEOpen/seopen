// How a grid point is drawn. Separate from the map so the contrast of every dot is unit tested.
import type { Bucket } from "./metrics";

/**
 * One fixed scale, green to raspberry, the same in both themes, so a map reads at a glance. It's the
 * owner's exception to the kit's colour rules, for this map only. The number on a dot carries
 * the rank, so nothing relies on the hue. Failed stays hollow: it says nothing about the rank.
 */
export const DOT: Record<Bucket, string> = {
  top3: "border-rank-light bg-rank-1 text-rank-ink",
  top10: "border-rank-light bg-rank-2 text-rank-ink",
  top20: "border-rank-light bg-rank-3 text-rank-ink",
  none: "border-rank-light bg-rank-4 text-rank-light",
  failed: "border-dashed border-line-strong bg-surface text-muted",
  pending: "border-line bg-surface-2 text-muted",
};

/**
 * Google's image stays light in both themes and isn't filtered, so the map frame keeps the light theme's
 * values on it. OpenStreetMap's tiles invert with the theme, so that map follows the theme's own tokens.
 * These match :root in globals.css, which dots.test.ts checks.
 */
export const LIGHT_BASE = {
  "--bg": "#f2f1ed",
  "--surface": "#ffffff",
  "--surface-2": "#d9d7d2",
  "--line": "rgba(22, 23, 27, 0.08)",
  "--line-strong": "#a3a098",
  "--fg": "#16171b",
  "--muted": "#64656a",
  "--accent": "#2f5fc4",
} as const;
