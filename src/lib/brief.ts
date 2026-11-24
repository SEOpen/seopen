/**
 * The sentence at the top of a page: what changed and against what, in plain words. Pure, so it costs
 * nothing to load and every page answers the same way. "Nothing moved" is a real, calm answer.
 */
import { countChange, describeChange, inPoints, magnitude, SMALL_BASE, type ChangeUnit } from "@/components/ui/module-card";
import type { ChangeDelta } from "@/components/ui/what-changed";
import { formatNumber } from "./format";

/** One thing that moved, as a clause that reads in the middle of a sentence. */
export interface Move {
  /** "clicks are up 12% on the 28 days before". Starts lowercase unless it's a name. */
  clause: string;
  /** `neutral`: it moved, but nothing a check confirmed says whether that's better, like a gain no look confirmed. */
  tone: "good" | "bad" | "neutral";
  /** How big the move is, so different measures rank together. Over about 0.1 is worth a line. */
  weight: number;
}

/** Below this a move isn't worth a line. */
export const MIN_WEIGHT = 0.1;

/** "but" only between a good and a bad move: a neutral one is no counterpoint to either. */
export const joiner = (a: Pick<Move, "tone">, b: Pick<Move, "tone">) => (a.tone !== b.tone && a.tone !== "neutral" && b.tone !== "neutral" ? "but" : "and");

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

/** "two", "12", "1,204": words up to nine, as a sentence would have them. */
export function countWord(n: number): string {
  return WORDS[n] ?? formatNumber(n);
}

/** "two keywords", "one keyword". */
export function countOf(n: number, noun: string, plural = `${noun}s`): string {
  return `${countWord(n)} ${n === 1 ? noun : plural}`;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Up to two moves as one sentence, the worst first. A bad and a good one always both show, so a page
 * can't read as all well with something falling. A neutral one never leads over either. With nothing
 * moved, the calm sentence it's given.
 */
export function briefSentence(moves: Move[], calm: string): string {
  const big = moves.filter((m) => m.weight >= MIN_WEIGHT).sort((a, b) => b.weight - a.weight);
  if (!big.length) return calm;
  const worst = big.find((m) => m.tone === "bad");
  const best = big.find((m) => m.tone === "good");
  const first = worst ?? best ?? big[0];
  const second = worst && best ? best : big.find((m) => m !== first);
  if (!second) return `${capitalize(first.clause)}.`;
  return `${capitalize(first.clause)}, ${joiner(first, second)} ${second.clause}.`;
}

/** Below this on both sides, a count's move isn't worth a sentence. */
const WORTH_SAYING = 20;

/** A signed change as a delta, with the arrow following the number. A ranking position reads "2.4 better". */
export function changeDelta(change: number, unit: ChangeUnit, goodWhen: "up" | "down", rank = false): ChangeDelta {
  const { text, tone } = describeChange(change, unit, goodWhen);
  if (tone === "muted") return { text, tone, up: null };
  if (rank) return { text: `${magnitude(Math.abs(change), unit)} ${tone === "good" ? "better" : "worse"}`, tone, up: tone === "good" };
  return { text, tone, up: change > 0 };
}

/** Two decimals for a move under a point, where one decimal would round a real change away. */
const smallPoints = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** A small rate against the one before, in points: 0.07% to 0.12% reads "+0.05 pts", not "No change". */
export function rateDelta(now: number, before: number, goodWhen: "up" | "down" = "up"): ChangeDelta {
  const change = now - before;
  const points = Math.abs(change) * 100;
  if (points >= 1) return changeDelta(change, "points", goodWhen);
  const size = smallPoints.format(points);
  if (!/[1-9]/.test(size)) return { text: "No change", tone: "muted", up: null };
  const up = change > 0;
  return { text: `${up ? "+" : "−"}${inPoints(size)}`, tone: up === (goodWhen === "up") ? "good" : "bad", up };
}

/**
 * A count against the one before: a percentage, or the plain difference on a small base, because
 * "▲ 164%" on 14 → 37 says more than the data does. Null when there's nothing earlier, or a large
 * count starts from zero.
 */
export function countDelta(now: number, before: number | null | undefined, goodWhen: "up" | "down" = "up"): ChangeDelta | null {
  if (before == null || (before === 0 && Math.abs(now) >= SMALL_BASE)) return null;
  const { value, unit } = countChange(now, before);
  return changeDelta(value, unit, goodWhen);
}

/** countDelta for a count whose change always shows: a percentage can't start from zero, so that reads as the plain difference. */
export function countDeltaFromZero(now: number, before: number | null | undefined, goodWhen: "up" | "down" = "up"): ChangeDelta | null {
  return countDelta(now, before, goodWhen) ?? (before == null ? null : changeDelta(now - before, "number", goodWhen));
}

/**
 * A count's change as a clause, in the same form as its figure: "clicks are up 12% on the 28 days
 * before", "clicks are up 23". Null below the size worth saying. Pass `money` to keep a percentage.
 */
export function countMove(noun: string, now: number, before: number | null | undefined, against: string, goodWhen: "up" | "down" = "up", money = false): Move | null {
  if (before == null || before === 0 || Math.max(now, before) < WORTH_SAYING) return null;
  const ratio = (now - before) / before;
  const { value, unit } = money ? { value: ratio, unit: "percent" as const } : countChange(now, before);
  const size = magnitude(Math.abs(value), unit);
  if (!/[1-9]/.test(size)) return null;
  const up = ratio > 0;
  return { clause: `${noun} are ${up ? "up" : "down"} ${size} ${against}`, tone: up === (goodWhen === "up") ? "good" : "bad", weight: Math.abs(ratio) };
}
