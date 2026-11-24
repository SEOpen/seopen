/**
 * AI visibility → Actions: what to do about each prompt whose latest answers don't name the site.
 * Worked out from the stored answers every time; only each action's status and the outreach list are
 * stored (`ai_actions`). Pure functions, no I/O. SEOpen never posts anywhere: a thread card only shows
 * the thread and the rule for joining it.
 */
import type { AiBrandMention, AiCitation } from "@/db/schema/ai";
import { citationLabel, hostMatches, namesBrand, readCitation, type Brand } from "./detect";
import { withoutFailedRuns } from "./metrics";
import { ownershipOf } from "./sources";

export const ACTION_KINDS = ["write", "featured", "thread"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const ACTION_STATUSES = ["open", "done", "dismissed"] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_LABEL: Record<ActionKind, string> = { write: "Write or extend a page", featured: "Get featured", thread: "Join a thread" };
export const STATUS_LABEL: Record<ActionStatus, string> = { open: "Open", done: "Done", dismissed: "Dismissed" };

/** Community sites where the move is taking part in the thread, not asking to be listed. Subdomains count. */
export const THREAD_SITES = ["reddit.com", "quora.com", "youtube.com", "youtu.be"];

/** Shown on every thread card. */
export const THREAD_RULE = "Answer the question first, say who you are, and post at most once a week in any one community.";

export const isThreadSite = (domain: string) => THREAD_SITES.some((s) => hostMatches(domain, s));

/** One finished answer, as `data.ts` reads them. */
export interface ActionAnswer {
  runId: number;
  promptId: number;
  prompt: string;
  platform: string;
  mentioned: boolean | null;
  citations: AiCitation[] | null;
  mentions: AiBrandMention[] | null;
  failed: boolean;
  /** Sortable run key: ISO run start, "#", padded run id. */
  at: string;
}

/** What `ai_actions` holds for one action. */
export interface StoredAction {
  promptId: number;
  kind: string;
  url: string;
  status: string;
  savedAt: Date | null;
}

export interface Action {
  kind: ActionKind;
  /** The cited page; empty for "write". */
  url: string;
  /** What the link reads. */
  label: string;
  title: string | null;
  domain: string | null;
  /** Answers in the run that cite this page and don't name the site ("write": answers that don't name the site). */
  answers: number;
  /** Platforms those answers came from. */
  platforms: string[];
  /** Tracked competitors those answers name, by display name. */
  competitors: string[];
  status: ActionStatus;
  saved: boolean;
}

/**
 * not_named: the latest run's answers don't all name the site, so there's work to do.
 * confirming: they do, but the run before didn't (or there's no run before), so it isn't settled yet.
 * resolved: the latest two runs both name the site in every answer.
 */
export type PromptState = "not_named" | "confirming" | "resolved";

export interface PromptActions {
  promptId: number;
  prompt: string;
  /** The question names the site's brand. */
  branded: boolean;
  state: PromptState;
  /** The prompt's latest run with an answer: id and start (ISO). */
  runId: number;
  runAt: string;
  /** Answers that came back in that run, and how many name the site. */
  answered: number;
  named: number;
  /** Platforms whose answer in that run doesn't name the site. */
  missedOn: string[];
  /** The run before, when there is one: its start (ISO) and whether every answer named the site. */
  previous: { runAt: string; named: boolean } | null;
  /** Empty unless `state` is not_named. */
  actions: Action[];
  /** Why a not_named prompt has no actions. */
  noneBecause: string | null;
}

/** The key one action is stored under. */
export const actionKey = (a: { promptId: number; kind: string; url: string }) => `${a.promptId}\u0000${a.kind}\u0000${a.url}`;

const runStart = (at: string) => at.split("#")[0];

const asStatus = (s: string | undefined): ActionStatus => (ACTION_STATUSES as readonly string[]).includes(s ?? "") ? (s as ActionStatus) : "open";

/** Every answer of the run names the site. */
const allNamed = (answers: ActionAnswer[]) => answers.length > 0 && answers.every((a) => a.mentioned);

/**
 * Each prompt's state and actions, worst first. Runs where every answer failed are left out, and a
 * failed answer counts for nothing: it isn't a miss. A prompt's latest run is the newest run that got an
 * answer to it. Named means every answer that came back names the site, so a prompt one platform still
 * leaves the site out of keeps its actions.
 */
export function buildPromptActions(rows: readonly ActionAnswer[], brands: Brand[], stored: readonly StoredAction[] = []): PromptActions[] {
  const own = brands.find((b) => b.own);
  const states = new Map(stored.map((s) => [actionKey(s), s]));
  const byPrompt = new Map<number, ActionAnswer[]>();
  for (const r of withoutFailedRuns([...rows])) {
    if (r.failed) continue;
    const list = byPrompt.get(r.promptId) ?? [];
    list.push(r);
    byPrompt.set(r.promptId, list);
  }
  const out: PromptActions[] = [];
  for (const [promptId, answers] of byPrompt) {
    const runs = [...new Set(answers.map((a) => a.at))].sort();
    const latestAt = runs.at(-1)!;
    const latest = answers.filter((a) => a.at === latestAt);
    const beforeAt = runs.at(-2);
    const before = beforeAt ? answers.filter((a) => a.at === beforeAt) : null;
    const namedNow = allNamed(latest);
    const namedBefore = before ? allNamed(before) : null;
    const state: PromptState = !namedNow ? "not_named" : namedBefore ? "resolved" : "confirming";
    const actions = state === "not_named" ? actionsFor(promptId, latest, brands, states) : [];
    out.push({
      promptId,
      prompt: latest[0].prompt,
      branded: own ? namesBrand(latest[0].prompt, own) : false,
      state,
      runId: latest[0].runId,
      runAt: runStart(latestAt),
      answered: latest.length,
      named: latest.filter((a) => a.mentioned).length,
      missedOn: latest.filter((a) => !a.mentioned).map((a) => a.platform),
      previous: before && beforeAt ? { runAt: runStart(beforeAt), named: !!namedBefore } : null,
      actions,
      noneBecause: state === "not_named" && !actions.length ? "Your site is cited but not named, and the other pages cited are competitors' or hide which site they're on." : null,
    });
  }
  const order: Record<PromptState, number> = { not_named: 0, confirming: 1, resolved: 2 };
  return out.sort((a, b) => order[a.state] - order[b.state] || b.missedOn.length - a.missedOn.length || a.promptId - b.promptId);
}

function actionsFor(promptId: number, latest: ActionAnswer[], brands: Brand[], states: Map<string, StoredAction>): Action[] {
  const nameOf = (domain: string) => brands.find((b) => b.domain === domain)?.name ?? domain;
  const competitorsIn = (answers: ActionAnswer[]) =>
    [...new Set(answers.flatMap((a) => (a.mentions ?? []).filter((m) => !m.own && m.count > 0).map((m) => nameOf(m.domain))))].sort((x, y) => x.localeCompare(y));
  const make = (kind: ActionKind, url: string, rest: Omit<Action, "kind" | "url" | "status" | "saved">): Action => {
    const s = states.get(actionKey({ promptId, kind, url }));
    return { kind, url, ...rest, status: asStatus(s?.status), saved: kind === "featured" && !!s?.savedAt };
  };

  const missed = latest.filter((a) => !a.mentioned);
  const citesYours = latest.some((a) => (a.citations ?? []).some((c) => {
    const domain = readCitation(c).domain;
    return !!domain && ownershipOf(domain, brands) === "yours";
  }));

  const actions: Action[] = [];
  if (!citesYours) {
    actions.push(make("write", "", { label: "", title: null, domain: null, answers: missed.length, platforms: missed.map((a) => a.platform), competitors: competitorsIn(missed) }));
  }

  // Third-party pages cited in the answers that leave the site out, by page.
  const pages = new Map<string, { kind: ActionKind; label: string; title: string | null; domain: string; answers: ActionAnswer[] }>();
  for (const a of missed) {
    for (const stored of a.citations ?? []) {
      const c = readCitation(stored);
      if (!c.domain || ownershipOf(c.domain, brands) !== "third_party") continue;
      const p = pages.get(c.url) ?? { kind: isThreadSite(c.domain) ? ("thread" as const) : ("featured" as const), label: citationLabel(c), title: c.title, domain: c.domain, answers: [] };
      if (!p.answers.includes(a)) p.answers.push(a);
      pages.set(c.url, p);
    }
  }
  const cited = [...pages.entries()]
    .map(([url, p]) => make(p.kind, url, { label: p.label, title: p.title, domain: p.domain, answers: p.answers.length, platforms: p.answers.map((a) => a.platform), competitors: competitorsIn(p.answers) }))
    .sort((x, y) => y.answers - x.answers || y.competitors.length - x.competitors.length || x.url.localeCompare(y.url));
  return [...actions, ...cited.filter((a) => a.kind === "featured"), ...cited.filter((a) => a.kind === "thread")];
}

/** How many open, done and dismissed actions there are. */
export function statusCounts(prompts: readonly PromptActions[]): Record<ActionStatus, number> {
  const counts: Record<ActionStatus, number> = { open: 0, done: 0, dismissed: 0 };
  for (const p of prompts) for (const a of p.actions) counts[a.status]++;
  return counts;
}
