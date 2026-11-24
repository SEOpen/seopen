/**
 * Google serves automated searches "poisoned" results pages: a normal-looking page whose organic
 * results are mostly swapped for unrelated ones. DataForSEO's `resolve_poisoned_results` (added
 * 2026-11-16) checks page 1 against Google's Web filter and, when they differ, takes the organic
 * results from the Web filter, later pages included, marking each with `checks: ["from_web"]`. It
 * leaves AI Overviews and other features as collected, and adds one base price per task whatever
 * the depth, clean pages included.
 *
 * Measured 2026-11-17 (one US city, depth 20, 12 keywords, three looks each on the Standard queue):
 * without it the top 10 matched between looks 39% of the time and one tracked site showed in 4 of 30
 * looks; with it 76% and 24 of 30, and 615 of 666 organic results came from the Web filter. Rank
 * checks and the live top 10 (keyword research, briefs, page refresh, MCP `serp`) send it. The AI
 * prompt module's weekly AI Overview tasks don't, since it can't change the Overview, and nor does
 * the public AI Overview checker yet, whose organic position is a side note (docs/dataforseo.md).
 */
export const RESOLVE_POISONED = { resolve_poisoned_results: true } as const;
