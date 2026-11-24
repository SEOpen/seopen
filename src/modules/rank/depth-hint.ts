// Why a tracked keyword shows no position when Search Console has one: the daily check only reads
// as deep as the project's depth, and the site sits further down. Pure, so the rules are unit tested
// (depth-hint.test.ts); the Rankings page and the MCP get_rankings tool show what it returns.
import { keywordUnits } from "@/lib/billing/gates";
import { plural } from "@/lib/ops";
import { rules } from "@/plan-policy/rules";
import { daysBefore } from "./recheck";

/** The daily check depths a project can choose, as Rankings settings offers them. */
export const DAILY_DEPTHS = [10, 20, 30, 50, 100] as const;

/** Search Console's window for the hint: its averages over this many days up to the latest check. */
export const DEPTH_HINT_DAYS = 28;

/** The window's first day: `DEPTH_HINT_DAYS` days counting the check's own. */
export const depthHintSince = (date: string) => daysBefore(date, DEPTH_HINT_DAYS - 1);

export interface DepthHintInput {
  /** Every active keyword's overview row, unfiltered. */
  rows: { id: number; keyword: string; position: number | null; checked: boolean }[];
  /** The deepest any check read for each keyword in the window (`deepestLooks`), to tell whether one already looked deep enough. */
  deepestLook: Map<number, number>;
  /** Search Console's average position over `DEPTH_HINT_DAYS`, keyed by lowercase keyword. */
  searchConsole: Map<string, number>;
  settings: { dailyDepth: number; sweepDepth: number; sweepWeekday: number; enabled: boolean };
}

export interface DepthHint {
  /** Keywords with no position whose Search Console average is past the daily depth. */
  keywords: number;
  /** The deepest of those averages, rounded. */
  deepest: number;
  /** The project's daily check depth now. */
  depth: number;
  /** The shallowest allowed depth that covers them all, or the deepest allowed one when none does; null when no deeper depth would cover any. */
  suggestedDepth: number | null;
  /** How many of them `suggestedDepth` covers. */
  covered: number;
  /** Keyword units one keyword uses at `depth`, and at `suggestedDepth`. */
  unitsNow: number;
  unitsSuggested: number | null;
  /** The project's active keywords, and the units they'd use together at each depth. */
  projectKeywords: number;
  /** The weekly check's depth when it runs and looks deeper than the daily one; null otherwise. */
  sweepDepth: number | null;
  /** Of them, how many the weekly check's depth covers and no check has looked for that deep yet. */
  sweepCovers: number;
  /** Of them, how many a check in the window already looked for deep enough, and didn't find. */
  lookedAlready: number;
  /** The whole hint as plain sentences. */
  message: string;
}

/**
 * The hint for keywords the latest check found nowhere while Search Console averages them past the
 * daily depth, or null when there are none. It says how deep would cover them and what that costs in
 * keyword units; it never changes the depth.
 */
export function depthHint(input: DepthHintInput): DepthHint | null {
  const { dailyDepth: depth } = input.settings;
  const deep = input.rows.flatMap((r) => {
    if (!r.checked || r.position != null) return [];
    const average = input.searchConsole.get(r.keyword.toLowerCase());
    return average != null && average > depth ? [{ id: r.id, average, looked: (input.deepestLook.get(r.id) ?? 0) >= average }] : [];
  });
  if (!deep.length) return null;

  const deepestAverage = Math.max(...deep.map((d) => d.average));
  const deeper = DAILY_DEPTHS.filter((d) => d > depth);
  const fits = deeper.find((d) => d >= deepestAverage) ?? deeper[deeper.length - 1] ?? null;
  const covered = fits == null ? 0 : deep.filter((d) => d.average <= fits).length;
  const suggestedDepth = covered ? fits : null;
  const s = input.settings;
  const sweepDepth = s.enabled && s.sweepWeekday >= 0 && s.sweepDepth > depth ? s.sweepDepth : null;
  const sweepCovers = sweepDepth == null ? 0 : deep.filter((d) => !d.looked && d.average <= sweepDepth).length;
  const lookedAlready = deep.filter((d) => d.looked).length;
  const projectKeywords = input.rows.length;
  const hint = {
    keywords: deep.length,
    deepest: Math.round(deepestAverage),
    depth,
    suggestedDepth,
    covered,
    unitsNow: keywordUnits(depth),
    unitsSuggested: suggestedDepth == null ? null : keywordUnits(suggestedDepth),
    projectKeywords,
    sweepDepth,
    sweepCovers,
    lookedAlready,
  };
  return { ...hint, message: depthHintMessage(hint) };
}

function depthHintMessage(h: Omit<DepthHint, "message">): string {
  const n = h.keywords;
  const they = n === 1 ? "it" : "they";
  const parts = [
    n === 1
      ? `1 keyword with no position here averages #${h.deepest} in Search Console over the last ${DEPTH_HINT_DAYS} days, past the top ${h.depth} the daily check reads.`
      : `${n} keywords with no position here average past the top ${h.depth} in Search Console over the last ${DEPTH_HINT_DAYS} days, down to #${h.deepest}. The daily check only reads the top ${h.depth}.`,
  ];
  if (h.suggestedDepth != null && h.unitsSuggested != null) {
    // Reading as deep as an average doesn't promise a find: a check may already have read that deep (`lookedAlready`).
    const reach = h.covered === n ? (n === 1 ? "would read as deep as its average" : "would read as deep as all their averages") : `would read as deep as the averages of ${h.covered} of them`;
    parts.push(
      rules.hasPlans
        ? `Checking the top ${h.suggestedDepth} ${reach}. Each keyword would then count as ${h.unitsSuggested} toward your plan's keyword limit instead of ${h.unitsNow}, one for each 10 results checked, so this project's ${plural(h.projectKeywords, "keyword")} would count as ${(h.projectKeywords * h.unitsSuggested).toLocaleString("en-US")} instead of ${(h.projectKeywords * h.unitsNow).toLocaleString("en-US")}.`
        : // DataForSEO charges a rank check per 10 results it reads (docs/dataforseo.md, "Depth billing").
          `Checking the top ${h.suggestedDepth} ${reach}. Each keyword's daily check would then read ${h.unitsSuggested} pages of 10 results instead of ${h.unitsNow}, and DataForSEO charges for every page.`,
    );
  } else {
    parts.push(`That's past the top ${DAILY_DEPTHS[DAILY_DEPTHS.length - 1]}, the deepest a daily check reads.`);
  }
  if (h.sweepCovers) {
    const which = h.sweepCovers === n ? they : `${h.sweepCovers} of them`;
    parts.push(`The weekly check reads the top ${h.sweepDepth}, so ${which} may show a position after its next run.`);
  }
  if (h.lookedAlready) {
    const which = h.lookedAlready === n ? (n === 1 ? "It" : "They") : `${h.lookedAlready} of them`;
    parts.push(
      `${which} didn't turn up in a check that read deep enough in the last ${DEPTH_HINT_DAYS} days either. Search Console averages every country and device, so a deeper daily check may not find ${h.lookedAlready === 1 ? "it" : "them"} here.`,
    );
  }
  return parts.join(" ");
}
