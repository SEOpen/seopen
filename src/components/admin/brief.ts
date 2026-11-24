/**
 * The tops of the Admin pages: one sentence and the figures under it, from numbers the page has already
 * read. Pure, so it's tested and costs nothing. Admin is owner-only, so dollars are fine here.
 *
 * Two kinds of "last 7 days". Overview and Spend add up UTC days, so theirs is today so far and the six
 * days before, and it's short of a full week until today ends. Users asks the database for
 * the 7 days up to now, compares nothing and can differ from Overview by a few hours' sign-ups.
 */
import type { FigureData } from "@/components/ui/figure";
import { rules } from "@/plan-policy/rules";
import { changeDelta, countOf, countWord } from "@/lib/brief";
import { formatNumber, formatUsd } from "@/lib/format";

/** How far back "the last" and "the before" reach in a sentence. */
const WINDOW_DAYS = 7;

type ValueFigure = Extract<FigureData, { state: "value" }>;

const value = (f: Omit<ValueFigure, "state" | "delta"> & { delta?: ValueFigure["delta"] }): FigureData => ({ state: "value", delta: null, ...f });

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface DayTotals {
  date: string;
  accounts: number;
  spendUsd: number;
}

/** A daily count beside the accounts, from the plan policy (`AdminDailyMeasure`): one of it, and its counts by UTC day. */
export interface DailyMeasure {
  noun: string;
  byDate: Record<string, number>;
}

/** A measure over the last 7 days and the 7 before. Days arrive oldest first. */
function lastTwoWeeks(days: DayTotals[], read: (d: DayTotals) => number): { now: number; before: number } {
  const sum = (rows: DayTotals[]) => rows.reduce((n, d) => n + read(d), 0);
  return { now: sum(days.slice(-WINDOW_DAYS)), before: sum(days.slice(-2 * WINDOW_DAYS, -WINDOW_DAYS)) };
}

/** "no new accounts", "one new account", "12 new accounts". */
const counted = (n: number, noun: string) => (n === 0 ? `no ${noun}s` : countOf(n, noun));

const ALSO_THE_SAME = `the same as the ${WINDOW_DAYS} days before`;

/** New accounts, then any daily count the plan adds, against the week before, then how many problems Health has open. */
export function overviewSentence(days: DayTotals[], problems: number, more: readonly DailyMeasure[] = []): string {
  const all = [{ noun: "new account", read: (d: DayTotals) => d.accounts }, ...more.map((m) => ({ noun: m.noun, read: (d: DayTotals) => m.byDate[d.date] ?? 0 }))];
  const measures = all.map((m) => ({ noun: m.noun, ...lastTwoWeeks(days, m.read) })).filter((m) => m.now || m.before);

  const activity = !measures.length
    ? `No ${all.map((m) => `${m.noun}s`).join(" or ")} in the last ${2 * WINDOW_DAYS} days.`
    : `${capitalize(measures.map((m) => counted(m.now, m.noun)).join(" and "))} in the last ${WINDOW_DAYS} days, ${
        measures.every((m) => m.now === m.before) ? ALSO_THE_SAME : `against ${measures.map((m) => (m.before ? countWord(m.before) : "none")).join(" and ")} in the ${WINDOW_DAYS} days before`
      }.`;
  return problems ? `${activity} Health has ${countOf(problems, "problem")} open.` : activity;
}

/** `days` is what the sentence reads, so the figure's new accounts and the sentence's are the same number. */
export function accountsFigure(accounts: number, days: DayTotals[]): FigureData {
  const { now: newAccounts } = lastTwoWeeks(days, (d) => d.accounts);
  return value({
    id: "accounts",
    label: "Accounts",
    value: formatNumber(accounts),
    delta: newAccounts ? changeDelta(newAccounts, "number", "up") : null,
    caption: newAccounts ? `in the last ${WINDOW_DAYS} days` : `none new in the last ${WINDOW_DAYS} days`,
  });
}

// ─── Health ──────────────────────────────────────────────────────────────────────────────────

export interface HealthCounts {
  /** Failed job runs in the last 7 days, not the groups of them. */
  failed: number;
  syncs: number;
  connections: number;
  paused: number;
  spend: number;
  /** Workspaces stopped by suspension or their plan (`AdminStopped`), or a workspace's own plan problems. */
  billing: number;
  /** One of `billing`, for the sentence (`AdminStopped.noun`). "billing problem" when left out. */
  billingNoun?: string;
  /** The figure that adds spend, `billing` and the balance together (`AdminStopped.figure`). "Spend and billing" when left out. */
  moneyLabel?: string;
  /** DataForSEO balance rows: platform-wide, so a workspace's own page has none. */
  balance?: number;
  /** Worker heartbeat rows (src/lib/jobs/worker-watch.ts): platform-wide too. */
  worker?: number;
}

/** Every open problem by kind, or null with none. A stopped worker or a low DataForSEO balance stops everything, so they lead. */
function problemsSentence(c: HealthCounts): string | null {
  const balance = c.balance ?? 0;
  const worker = c.worker ?? 0;
  const parts = [
    worker ? countOf(worker, "worker problem") : null,
    balance ? countOf(balance, "DataForSEO balance problem") : null,
    c.failed ? `${countOf(c.failed, "failed job")} in the last ${WINDOW_DAYS} days` : null,
    c.syncs ? countOf(c.syncs, "sync problem") : null,
    c.connections ? countOf(c.connections, "broken connection") : null,
    c.paused ? countOf(c.paused, "paused job") : null,
    c.spend ? `${countOf(c.spend, "workspace")} over a spend alert or near a ceiling` : null,
    c.billing ? countOf(c.billing, c.billingNoun ?? "billing problem") : null,
  ].filter((p) => p != null);
  if (!parts.length) return null;
  const total = worker + balance + c.failed + c.syncs + c.connections + c.paused + c.spend + c.billing;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${capitalize(list)} ${total === 1 ? "needs" : "need"} a look.`;
}

/** A list can't read as all well with something in it. */
export function healthSentence(c: HealthCounts): string {
  return problemsSentence(c) ?? `Nothing needs a look. No jobs failed in the last ${WINDOW_DAYS} days, and no workspace has an open problem.`;
}

export function healthFigures(c: HealthCounts): FigureData[] {
  return [
    value({ id: "failed", label: `Failed jobs (${WINDOW_DAYS} days)`, value: formatNumber(c.failed) }),
    value({ id: "syncs", label: "Syncs with a problem", value: formatNumber(c.syncs) }),
    value({ id: "paused", label: "Paused jobs", value: formatNumber(c.paused) }),
    value({ id: "money", label: c.moneyLabel ?? "Spend and billing", value: formatNumber(c.spend + c.billing + (c.balance ?? 0)) }),
  ];
}

// ─── Spend ───────────────────────────────────────────────────────────────────────────────────

const whole = (usd: number) => formatUsd(usd, 0);
const cents = (usd: number) => formatUsd(usd, 2);

/** DataForSEO's bill across every workspace against the week before, then where the owner workspace's cap stands. */
export function spendSentence(days: DayTotals[], ownerSpent: number, ownerCap: number): string {
  const { now, before } = lastTwoWeeks(days, (d) => d.spendUsd);
  const bill = !now && !before
    ? `No DataForSEO spend across any workspace in the last ${2 * WINDOW_DAYS} days.`
    : `DataForSEO spend was ${cents(now)} across every workspace in the last ${WINDOW_DAYS} days, ${cents(now) === cents(before) ? ALSO_THE_SAME : `against ${cents(before)} in the ${WINDOW_DAYS} days before`}.`;
  const owner = ownerSpent >= ownerCap ? `The owner workspace is at its ${whole(ownerCap)} cap, so its paid calls have stopped.` : `The owner workspace has used ${cents(ownerSpent)} of its ${whole(ownerCap)} cap this month.`;
  return `${bill} ${owner}`;
}

export function spendFigures(spent: number, cap: number, byModule: { module: string; cost: number; calls: number }[]): FigureData[] {
  const top = [...byModule].sort((a, b) => b.cost - a.cost)[0];
  return [
    value({ id: "owner", label: "Owner workspace this month", value: cents(spent), caption: `of ${whole(cap)} cap` }),
    value({ id: "remaining", label: "Remaining", value: cents(Math.max(cap - spent, 0)) }),
    value({ id: "calls", label: "Paid calls this month", value: formatNumber(byModule.reduce((n, r) => n + r.calls, 0)) }),
    top ? value({ id: "top", label: "Top module", value: top.module, caption: `${cents(top.cost)} this month` }) : { id: "top", label: "Top module", state: "empty", text: "No paid calls this month." },
  ];
}

// ─── Users ───────────────────────────────────────────────────────────────────────────────────

export interface UserCounts {
  accounts: number;
  /** Signed up in the 7 days up to now. */
  newThisWeek: number;
  /** Had a session in the 7 days up to now. */
  seenThisWeek: number;
  unverified: number;
}

/** Who signed up and who came back, then anyone who still hasn't verified. */
export function usersSentence(c: UserCounts): string {
  if (!c.accounts) return "There are no accounts yet.";
  const signedUp = capitalize(counted(c.newThisWeek, "new account"));
  const seen = !c.seenThisWeek
    ? "no account was seen in that time"
    : c.seenThisWeek === c.accounts
      ? c.accounts === 1
        ? "the only account was seen in that time"
        : `all ${countOf(c.accounts, "account")} were seen in that time`
      : `${countWord(c.seenThisWeek)} of ${countOf(c.accounts, "account")} ${c.seenThisWeek === 1 ? "was" : "were"} seen in that time`;
  const unverified = c.unverified ? ` ${capitalize(countOf(c.unverified, "account"))} ${c.unverified === 1 ? "hasn't verified its" : "haven't verified their"} email.` : "";
  return `${signedUp} in the last ${WINDOW_DAYS} days, and ${seen}.${unverified}`;
}

// ─── Workspaces ──────────────────────────────────────────────────────────────────────────────

export interface WorkspaceCounts {
  total: number;
  /** What they're on, from the plan policy (`AdminWorkspaces.kinds`), such as "none on a plan". */
  kinds: readonly string[];
  suspended: number;
  /** Workspaces over a spend alert now. */
  alerts: number;
  /** DataForSEO's bill this month across every workspace. */
  spentUsd: number;
  /** The platform cap. There is always one: an unset one reads as the default (`platformCapUsd`). */
  capUsd: number;
}

/** What the workspaces are on, then the platform's bill against its cap, then spend alerts. */
export function workspacesSentence(c: WorkspaceCounts): string {
  const kinds = [...c.kinds, c.suspended ? `${countWord(c.suspended)} suspended` : null].filter((k) => k != null);
  const list = kinds.length > 1 ? `${kinds.slice(0, -1).join(", ")} and ${kinds.at(-1)}` : kinds[0];
  const there = c.total === 1 ? "There is one workspace" : `There are ${formatNumber(c.total)} workspaces`;
  const mix = list ? `${there}: ${list}.` : `${there}.`;
  const bill =
    c.spentUsd >= c.capUsd
      ? `DataForSEO spend has reached the ${whole(c.capUsd)} platform cap, so paid calls have stopped.`
      : `DataForSEO spend is ${cents(c.spentUsd)} of the ${whole(c.capUsd)} platform cap this month.`;
  const alerts = c.alerts ? `${capitalize(countOf(c.alerts, "workspace"))} ${c.alerts === 1 ? "is" : "are"} over a spend alert.` : "No workspace is over a spend alert.";
  return `${mix} ${bill} ${alerts}`;
}

export interface WorkspaceStanding {
  plan: string;
  suspended: boolean;
  spentUsd: number;
  /**
   * The ceiling its paid calls are checked against this month, from spendState: its own cap, a
   * trial's earlier spend and the internal cap are already applied. Infinity with none.
   */
  ceilingUsd: number;
  problems: Omit<HealthCounts, "spend">;
}

/** What sits under this month's spend on a workspace's page. */
export function ceilingCaption(ceilingUsd: number): string {
  return Number.isFinite(ceilingUsd) ? `of ${cents(ceilingUsd)} ceiling` : "no ceiling";
}

/** Whether its paid calls can run and where its spend stands, then what needs a look. */
export function workspaceSentence(w: WorkspaceStanding): string {
  const spentSoFar = w.spentUsd > 0 ? ` It has spent ${cents(w.spentUsd)} this month.` : "";
  const on = rules.planPhrase(w.plan);
  const standing = w.suspended
    ? `This workspace is suspended, so its paid calls and jobs have stopped.${spentSoFar}`
    : w.plan === "none"
      ? `This workspace has no plan, so its paid calls have stopped.${spentSoFar}`
      : !Number.isFinite(w.ceilingUsd)
        ? `This workspace is ${on} and has spent ${cents(w.spentUsd)} this month.`
        : w.spentUsd >= w.ceilingUsd
          ? `This workspace is ${on} and has reached its ${cents(w.ceilingUsd)} ceiling, so its paid calls have stopped.`
          : `This workspace is ${on} and has spent ${cents(w.spentUsd)} of its ${cents(w.ceilingUsd)} ceiling this month.`;
  return `${standing} ${problemsSentence({ ...w.problems, spend: 0 }) ?? "Nothing needs a look."}`;
}

// ─── Tables ──────────────────────────────────────────────────────────────────────────────────

const isBlank = (v: unknown) => v == null || v === "" || v === "–";

/** The columns with something to show. A column with nothing in any row goes; with no rows at all, every head stays. */
export function columnsWithData<C extends { key: string }>(columns: C[], rows: Record<string, unknown>[]): C[] {
  if (!rows.length) return columns;
  return columns.filter((c) => rows.some((r) => !isBlank(r[c.key])));
}
