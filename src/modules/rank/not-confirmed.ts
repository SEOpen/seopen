/**
 * How much of the rank figures rests on positions no look could confirm, for what reads them outside the
 * Rankings page and the Overview's card (MCP). Those positions stay in the figures: `Summary` says how much
 * of each is theirs, and docs/dataforseo.md, Rechecks, says why.
 */
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { summarizeByDate } from "./metrics";
import { currentPlaceFilter, recentDailyPositions } from "./queries";
import { carryDeepPositions } from "./recheck";

/** The rank card's window (dashboard.tsx), so this reads the check the card calls `latest`. */
const DAYS = 30;

const PAGE_ONE = 10;

const onPageOne = (position: number | null) => position != null && position <= PAGE_ONE;

/** The summary of the check the rank card reads as `latest`, from the same rows. Null with no check in its window. */
export async function latestCheckSummary(project: Project) {
  const rows = await recentDailyPositions(projectScope(project), DAYS, currentPlaceFilter(project));
  return summarizeByDate(carryDeepPositions(rows)).at(-1) ?? null;
}

/** Keywords on page one on a position no look confirmed that weren't at the start, as the Rankings sentence counts them. */
export function pageOneGainsInRows(rows: { position: number | null; start: number | null; notChecked: boolean }[]): number {
  return rows.filter((r) => r.notChecked && onPageOne(r.position) && !onPageOne(r.start)).length;
}
