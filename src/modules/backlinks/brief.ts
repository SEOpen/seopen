/**
 * The tops of the Backlinks pages: one sentence and the figures under it, from stored snapshots and
 * responses already cached. Pure, so it's tested and costs nothing. These lists have no earlier reading
 * to compare against, so their sentences say what the list holds, not what changed.
 */
import type { FigureData } from "@/components/ui/figure";
import { chartDay } from "@/components/ui/module-card";
import { briefSentence, changeDelta, countDelta, countMove, countOf, countWord, MIN_WEIGHT, type Move } from "@/lib/brief";
import { formatDay, formatNumber, formatPct, formatShortDate } from "@/lib/format";
import { rules } from "@/plan-policy/rules";
import type { FetchMeta } from "./api";
import { isSameBrand, isWithinDays, type AnchorClass, type GapRow, type NewLostPoint, type PreparedGap } from "./logic";

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A spam score the review rules call high. */
const HIGH_SPAM = 60;
/** A spam score under the review rules' first step. */
const LOW_SPAM = 30;
/** How far back "new" reaches on the lists. */
const RECENT_DAYS = 30;

type ValueFigure = Extract<FigureData, { state: "value" }>;

const value = (f: Omit<ValueFigure, "state" | "delta"> & { delta?: ValueFigure["delta"] }): FigureData => ({ state: "value", delta: null, ...f });

/** Where the header's numbers came from and how old they are. */
export function freshnessOf(metas: Pick<FetchMeta, "cached" | "fetchedAt">[], timeZone: string): string {
  if (metas.some((m) => !m.cached)) return "Fetched just now.";
  const dates = metas.flatMap((m) => (m.fetchedAt ? [m.fetchedAt] : [])).sort((a, b) => a.getTime() - b.getTime());
  return dates.length ? `Last fetched ${formatShortDate(dates[0], timeZone)}.` : "Loaded from saved data.";
}

/**
 * The Backlinks overview's freshness. Its numbers keep 24 hours and its monthly trend 7 days, so they
 * can be days apart, and the numbers on the page shouldn't read as old as the trend under them.
 */
export function overviewFreshness(summary: Pick<FetchMeta, "cached" | "fetchedAt">, trend: Pick<FetchMeta, "cached" | "fetchedAt">, timeZone: string): string {
  const when = (m: Pick<FetchMeta, "cached" | "fetchedAt">) => (!m.cached ? "just now" : m.fetchedAt ? formatShortDate(m.fetchedAt, timeZone) : null);
  const [numbers, months] = [when(summary), when(trend)];
  if (!numbers || !months || numbers === months) return freshnessOf([summary, trend], timeZone);
  return `Numbers fetched ${numbers}, monthly trend fetched ${months}.`;
}

/** The snapshot day these numbers belong to: the day they were fetched (a UTC day, as snapshots are), so saved numbers aren't compared with their own snapshot. */
export function readingDay(meta: Pick<FetchMeta, "fetchedAt">, now = new Date()): string {
  return (meta.fetchedAt ?? now).toISOString().slice(0, 10);
}

/** The months a new-and-lost chart holds, from the data: the provider's window runs into the current, unfinished month. */
export function monthSpan(series: { date: string }[]): string {
  const label = (month: string) => formatDay(`${month}-01`).replace(/ \d+,/, "");
  const [first, last] = [series[0]?.date, series.at(-1)?.date];
  if (!first || !last) return "Per month";
  return first === last ? `Per month, ${label(last)}` : `Per month, ${label(first)} to ${label(last)}`;
}

/** The domain's own score in the profile. The figure at the top of the page is a different number: the score across the links pointing here. */
export function domainSpamRow(score: number | null | undefined): [string, string] {
  return ["This domain's own spam score", score != null ? String(score) : "–"];
}

/**
 * What a Run prompt says. `missing`: stored numbers are already on the page, so it names what they don't
 * cover, or "isn't loaded yet" would read as being about the numbers right above it.
 */
export function loadPromptText(what: string, target: string, ttl: string, missing?: string): { title: string; description: string } {
  const free = `kept for ${ttl}, so reloading and sharing the page are free afterwards.`;
  const spends = rules.hasPlans ? `uses ${rules.researchNoun}` : "spends on DataForSEO";
  const plural = { title: "aren't loaded yet", description: `Loading them ${spends}. They're then ${free}` };
  if (missing) return { title: `${missing} ${plural.title}`, description: plural.description };
  // The name's own noun, before "of" or "against": "Anchors" and "Live referring domains" are plural, "The rest of the overview" isn't.
  const noun = what.split(/ (?:of|against) /)[0].split(" ").pop() ?? "";
  if (/[^s]s$/.test(noun)) return { title: `${what} for ${target} ${plural.title}`, description: plural.description };
  return { title: `${what} for ${target} isn't loaded yet`, description: `Loading it ${spends}. It's then ${free}` };
}

// ─── Overview ────────────────────────────────────────────────────────────────────────────────

export interface LinkReading {
  date: string;
  backlinks: number;
  referringDomains: number;
  rank: number | null;
  spamScore: number | null;
}

/** The newest stored reading before `date`. Snapshots arrive oldest first. */
export function readingBefore<T extends { date: string }>(snapshots: T[], date: string): T | null {
  return snapshots.filter((s) => s.date < date).at(-1) ?? null;
}

/** A count's change as a clause. Small counts say the numbers, because "up 40%" on 5 → 7 overstates it. */
function linkMove(noun: string, now: number, before: number): Move | null {
  if (now === before) return null;
  const big = countMove(noun, now, before, "");
  if (big) return { ...big, clause: big.clause.trim() };
  if (Math.max(now, before) >= 20 && before !== 0) return null; // Rounds to no change.
  return { clause: `${noun} went from ${formatNumber(before)} to ${formatNumber(now)}`, tone: now > before ? "good" : "bad", weight: MIN_WEIGHT };
}

/** The listed referring domains first seen after the earlier reading's day, and how many of them score high for spam. */
export interface NewSpam {
  fresh: number;
  high: number;
}

/**
 * From the live referring-domain list (the strongest 500, cached), so it costs nothing and covers a small
 * site's whole list. Rows with no first-seen date can't be placed, so they don't count.
 */
export function newDomainSpam(rows: { firstSeen: string | null; spamScore: number | null }[], since: string): NewSpam {
  const fresh = rows.filter((r) => r.firstSeen != null && r.firstSeen.slice(0, 10) > since);
  return { fresh: fresh.length, high: fresh.filter((r) => (r.spamScore ?? 0) >= HIGH_SPAM).length };
}

/** A rise made mostly of high-spam domains isn't good news, and the page shouldn't say it is. */
const mostlySpam = (now: LinkReading, before: LinkReading | null, spam: NewSpam | null | undefined): spam is NewSpam =>
  !!before && !!spam && now.referringDomains > before.referringDomains && spam.high * 2 > spam.fresh;

/**
 * What moved since the last stored reading. Referring domains and backlinks are what the page is for.
 * `spam`: the domains new since `before`, when the referring-domain list is cached.
 */
export function overviewSentence(now: LinkReading, before: LinkReading | null, spam?: NewSpam | null): string {
  if (!before) return `First reading on ${chartDay(now.date)}. Changes show after the next one.`;
  const since = chartDay(before.date);
  const moved = now.referringDomains !== before.referringDomains || now.backlinks !== before.backlinks;
  if (!moved) return `Nothing moved since ${since}.`;
  const moves = [linkMove("referring domains", now.referringDomains, before.referringDomains), linkMove("backlinks", now.backlinks, before.backlinks)].filter((m) => m != null);
  const sentence = briefSentence(moves, "");
  if (!sentence) return `Referring domains and backlinks barely moved since ${since}.`;
  const caveat = mostlySpam(now, before, spam) ? `, but ${formatNumber(spam.high)} of the ${countOf(spam.fresh, "domain")} new since then have a high spam score (${HIGH_SPAM} or more)` : "";
  return `${sentence.slice(0, -1)}, compared with ${since}${caveat}.`;
}

/** "2026-11" → "Nov 2026". */
function monthName(month: string): string {
  return new Date(`${month.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** For a domain with no stored readings of its own: what the latest month on record gained and lost. */
export function monthSentence(series: NewLostPoint[]): string {
  const latest = series.at(-1);
  if (!latest) return "No new or lost referring domains on record.";
  const month = monthName(latest.date);
  const gained = latest.newDomains;
  const lost = Math.abs(latest.lostDomains);
  if (gained && lost) return `${capitalize(countOf(gained, "new referring domain"))} and ${countWord(lost)} lost in ${month}.`;
  if (gained) return `${capitalize(countOf(gained, "new referring domain"))} in ${month}.`;
  if (lost) return `${capitalize(countOf(lost, "referring domain"))} lost in ${month}.`;
  return `No referring domains gained or lost in ${month}.`;
}

/** A spam score in words, by the review rules' steps. It's one score across the links, so it describes the score and counts nothing. */
export function spamVerdict(score: number): string {
  if (score >= HIGH_SPAM) return "High score";
  return score >= LOW_SPAM ? "Middling score" : "Low score";
}

/** The four numbers the page leads on. `tracked`: this domain keeps readings, so "nothing earlier" is worth saying. */
export function overviewFigures(now: LinkReading, before: LinkReading | null, tracked: boolean, reviewHref: string, spam?: NewSpam | null): FigureData[] {
  const versus = (a: number | null, b: number | null | undefined): string | null => {
    if (!before || b == null) return tracked ? "nothing earlier to compare" : null;
    return a === b ? `same as ${chartDay(before.date)}` : `vs ${chartDay(before.date)}`;
  };
  const caption = (lead: string, a: number | null, b: number | null | undefined) => [lead, versus(a, b)].filter(Boolean).join(", ");
  const moved = (a: number | null, b: number | null | undefined) => a != null && b != null && a !== b;
  const domainsDelta = before && moved(now.referringDomains, before.referringDomains) ? countDelta(now.referringDomains, before.referringDomains) : null;
  const spammy = mostlySpam(now, before, spam);
  // The summary and the Referring domains tab's list count differently, so each says which it is.
  const domainsCaption = caption("sites linking here by the link index's summary", now.referringDomains, before?.referringDomains);
  return [
    value({
      id: "domains",
      label: "Referring domains",
      value: formatNumber(now.referringDomains),
      delta: domainsDelta && spammy ? { ...domainsDelta, tone: "muted" } : domainsDelta,
      caption: spammy ? `${domainsCaption}. ${formatNumber(spam.high)} of ${formatNumber(spam.fresh)} new score high for spam` : domainsCaption,
    }),
    value({
      id: "backlinks",
      label: "Backlinks",
      value: formatNumber(now.backlinks),
      delta: before && moved(now.backlinks, before.backlinks) ? countDelta(now.backlinks, before.backlinks) : null,
      caption: caption("links in total", now.backlinks, before?.backlinks),
    }),
    now.rank == null
      ? { id: "rank", label: "Domain strength", state: "empty", text: "Our link index has no score for this domain." }
      : value({
          id: "rank",
          label: "Domain strength",
          value: formatNumber(now.rank),
          delta: before?.rank != null && moved(now.rank, before.rank) ? changeDelta(now.rank - before.rank, "number", "up") : null,
          caption: `${caption("Score out of 1,000", now.rank, before?.rank)}. Most useful compared with competitors`,
        }),
    now.spamScore == null
      ? { id: "spam", label: "Spam score", state: "empty", text: "Our link index has no spam score for these links." }
      : value({
          id: "spam",
          label: "Spam score",
          value: formatNumber(now.spamScore),
          delta: before?.spamScore != null && moved(now.spamScore, before.spamScore) ? changeDelta(now.spamScore - before.spamScore, "number", "down") : null,
          // With no backlinks there's nothing for the score to judge, so it gets no verdict.
          caption: `${now.backlinks > 0 ? `${spamVerdict(now.spamScore)}, lower is better. ` : ""}${caption("Across the links pointing here, out of 100", now.spamScore, before?.spamScore)}`,
          href: reviewHref,
        }),
  ];
}

// ─── Referring domains ───────────────────────────────────────────────────────────────────────

export interface DomainFacts {
  firstSeen: string | null;
  lostDate: string | null;
  /** Whether this domain's links are marked nofollow. */
  nofollow: boolean;
  spamScore: number | null;
}

/**
 * What the list says about the last 30 days. It loads the strongest domains only, and the dates of the rest
 * are unknown, so a longer list than that speaks only for the ones loaded.
 */
export function domainsSentence(status: "live" | "lost", total: number, rows: DomainFacts[], now: Date = new Date()): string {
  const lost = status === "lost";
  if (!total) return lost ? "No lost domains on record." : "No domains link here yet.";
  if (!rows.length) return `${capitalize(countOf(total, "domain"))} ${lost ? "stopped linking" : total === 1 ? "links here" : "link here"}.`;
  const recent = rows.filter((r) => isWithinDays(lost ? r.lostDate : r.firstSeen, RECENT_DAYS, now)).length;
  const days = `in the last ${RECENT_DAYS} days`;
  if (rows.length < total) {
    const strongest = `the ${formatNumber(rows.length)} strongest`;
    if (lost) return recent ? `${capitalize(countWord(recent))} of ${strongest} lost domains stopped linking ${days}.` : `${capitalize(countOf(total, "domain"))} stopped linking, none of ${strongest} ${days}.`;
    return `${recent ? capitalize(countWord(recent)) : "None"} of ${strongest} domains started linking ${days}.`;
  }
  if (lost) return recent ? `${capitalize(countOf(recent, "domain"))} stopped linking ${days}.` : `${capitalize(countOf(total, "domain"))} stopped linking, none of them ${days}.`;
  return recent ? `${capitalize(countOf(recent, "domain"))} started linking ${days}.` : `No new domains ${days}.`;
}

export function domainsFigures(status: "live" | "lost", total: number, rows: DomainFacts[], reviewHref: string, now: Date = new Date()): FigureData[] {
  const shown = `in the ${formatNumber(rows.length)} shown`;
  const recent = rows.filter((r) => isWithinDays(status === "lost" ? r.lostDate : r.firstSeen, RECENT_DAYS, now)).length;
  return [
    value({ id: "total", label: status === "lost" ? "Lost domains" : "Referring domains", value: formatNumber(total), caption: status === "lost" ? "no longer link here" : "link here now by the link index's domain list, which counts apart from its summary on Overview" }),
    value({ id: "recent", label: status === "lost" ? `Lost in ${RECENT_DAYS} days` : `New in ${RECENT_DAYS} days`, value: formatNumber(recent), caption: shown }),
    value({ id: "followed", label: "Followed", value: `${formatNumber(rows.filter((r) => !r.nofollow).length)} of ${formatNumber(rows.length)}`, caption: `not marked nofollow, ${shown}` }),
    value({ id: "spam", label: "High spam score", value: formatNumber(rows.filter((r) => (r.spamScore ?? 0) >= HIGH_SPAM).length), caption: `${HIGH_SPAM} or more, ${shown}`, href: reviewHref }),
  ];
}

// ─── Links ───────────────────────────────────────────────────────────────────────────────────

export interface LinkFacts {
  dofollow: boolean;
  is_new: boolean;
  is_broken: boolean;
}

export function linksSentence(status: "live" | "new" | "lost", total: number, rows: LinkFacts[]): string {
  if (!total) return status === "live" ? "No links point here yet." : `No ${status} links on record.`;
  if (status === "new") return `${capitalize(countOf(total, "new link"))} on record.`;
  if (status === "lost") return `${capitalize(countOf(total, "lost link"))} on record.`;
  const fresh = rows.filter((r) => r.is_new).length;
  const broken = rows.filter((r) => r.is_broken).length;
  const scope = rows.length < total ? `the ${formatNumber(rows.length)} strongest links` : countOf(rows.length, "link");
  if (!fresh && !broken) return `Nothing new or broken among ${scope}.`;
  const parts = [fresh ? `${countWord(fresh)} ${fresh === 1 ? "is" : "are"} new` : null, broken ? `${countWord(broken)} ${broken === 1 ? "is" : "are"} broken` : null].filter(Boolean);
  return `Of ${scope}, ${parts.join(" and ")}.`;
}

export function linksFigures(status: "live" | "new" | "lost", total: number, rows: LinkFacts[]): FigureData[] {
  const shown = `in the ${formatNumber(rows.length)} shown`;
  return [
    value({ id: "total", label: status === "live" ? "Links" : status === "new" ? "New links" : "Lost links", value: formatNumber(total), caption: status === "live" ? "point here now" : "on record" }),
    value({ id: "followed", label: "Followed", value: `${formatNumber(rows.filter((r) => r.dofollow).length)} of ${formatNumber(rows.length)}`, caption: `not marked nofollow, ${shown}` }),
    value({ id: "new", label: "Marked new", value: formatNumber(rows.filter((r) => r.is_new).length), caption: shown }),
    value({ id: "broken", label: "Broken", value: formatNumber(rows.filter((r) => r.is_broken).length), caption: shown }),
  ];
}

// ─── Anchors ─────────────────────────────────────────────────────────────────────────────────

const CLASS_PHRASE: Record<AnchorClass, string> = {
  branded: "mention your brand",
  url: "show a bare web address",
  exact: "use one of your keywords exactly",
  partial: "contain one of your keywords",
  generic: "use generic words such as “click here”",
  other: "use other wording",
};

/** Backlinks per class, as shares of the rows given. The list loads the most used link texts only, so that may not be all of them. */
export function anchorShares(rows: { class: AnchorClass; backlinks: number }[]): { total: number; share: (c: AnchorClass) => number; count: (c: AnchorClass) => number } {
  const byClass = new Map<AnchorClass, number>();
  for (const r of rows) byClass.set(r.class, (byClass.get(r.class) ?? 0) + r.backlinks);
  const total = rows.reduce((n, r) => n + r.backlinks, 0);
  const count = (c: AnchorClass) => byClass.get(c) ?? 0;
  return { total, count, share: (c) => count(c) / (total || 1) };
}

/** `total` is how many link texts there are in all, so a longer list than the rows speaks only for the rows. */
export function anchorsSentence(rows: { class: AnchorClass; backlinks: number }[], total: number): string {
  const { total: links, count, share } = anchorShares(rows);
  if (!links) return "No link text on record yet.";
  const top = (Object.keys(CLASS_PHRASE) as AnchorClass[]).sort((a, b) => count(b) - count(a))[0];
  // Few enough links to count on one hand or two, so say how many rather than a percentage.
  const said = links < 20 ? `${countWord(count(top))} of ${countOf(links, "link")} ${CLASS_PHRASE[top]}` : `${formatPct(share(top), 0)} of links ${CLASS_PHRASE[top]}`;
  return rows.length < total ? `Among the ${formatNumber(rows.length)} most used link texts, ${said}.` : `${capitalize(said)}.`;
}

export function anchorsFigures(rows: { class: AnchorClass; backlinks: number }[], total: number, hasKeywords: boolean, keywordsHref: string): FigureData[] {
  const { share } = anchorShares(rows);
  const shown = rows.length < total ? `, in the ${formatNumber(rows.length)} shown` : "";
  return [
    value({ id: "total", label: "Link texts", value: formatNumber(total), caption: `different wordings, ${formatNumber(rows.length)} shown` }),
    value({ id: "branded", label: "Branded", value: formatPct(share("branded"), 0), caption: `of links mention your brand${shown}` }),
    hasKeywords
      ? value({ id: "keywords", label: "Your keywords", value: formatPct(share("exact") + share("partial"), 0), caption: `of links use your keywords${shown}` })
      : { id: "keywords", label: "Your keywords", state: "empty", text: "Add your main keywords to see this.", action: { label: "Add keywords", href: keywordsHref } },
    value({ id: "generic", label: "Generic", value: formatPct(share("generic"), 0), caption: `of links say “click here” or the like${shown}` }),
  ];
}

// ─── Link gap ────────────────────────────────────────────────────────────────────────────────

export function gapSentence(rows: Pick<GapRow, "competitorCount">[], competitors: string[], target: string): string {
  const who = competitors.length === 1 ? competitors[0] : "your competitors";
  if (!rows.length) return `Nothing found: the strongest sites linking to ${who} already link to ${target} too.`;
  const several = rows.filter((r) => r.competitorCount > 1).length;
  const lead = `${capitalize(countOf(rows.length, "domain"))} ${rows.length === 1 ? "links" : "link"} to ${who} but not to ${target}`;
  return several ? `${lead}, and ${countWord(several)} of them ${several === 1 ? "links" : "link"} to more than one.` : `${lead}.`;
}

export function gapFigures(rows: Pick<GapRow, "competitorCount" | "spamScore">[], competitors: string[], perCompetitor: number): FigureData[] {
  return [
    value({ id: "prospects", label: "Prospects", value: formatNumber(rows.length), caption: `from the top ${formatNumber(perCompetitor)} referring domains of each competitor` }),
    value({ id: "several", label: "Link to several", value: formatNumber(rows.filter((r) => r.competitorCount > 1).length), caption: "link to more than one competitor" }),
    value({ id: "low-spam", label: "Low spam score", value: formatNumber(rows.filter((r) => r.spamScore != null && r.spamScore < LOW_SPAM).length), caption: `under ${LOW_SPAM} of 100` }),
    value({ id: "competitors", label: "Competitors", value: formatNumber(competitors.length), caption: competitors.join(", ") }),
  ];
}

/** Names shown per group in `gapHiddenNote` before the rest are counted. */
const HIDDEN_NAMED = 5;

/**
 * What the Link gap page leaves out, so nothing goes silently: the universal linkers, then your own and
 * the competitors' sites under another name, up to five names each. Null when nothing was left out.
 */
export function gapHiddenNote({ ownSites, universalLinkers }: Pick<PreparedGap, "ownSites" | "universalLinkers">, target: string): string | null {
  const list = (names: string[]) => new Intl.ListFormat("en-US", { type: "conjunction" }).format(names.length > HIDDEN_NAMED ? [...names.slice(0, HIDDEN_NAMED), `${formatNumber(names.length - HIDDEN_NAMED)} more`] : names);
  const yours = ownSites.filter((d) => isSameBrand(d, [target]));
  const theirs = ownSites.filter((d) => !isSameBrand(d, [target]));
  const parts = [
    universalLinkers.length ? `${list(universalLinkers)}, which ${universalLinkers.length === 1 ? "links" : "link"} to nearly every site` : null,
    yours.length ? `${list(yours)}, ${yours.length === 1 ? "your own site" : "your own sites"}` : null,
    theirs.length ? `${list(theirs)}, ${theirs.length === 1 ? "a competitor's own site" : "competitors' own sites"}` : null,
  ].filter((p) => p != null);
  return parts.length ? `Not shown: ${parts.join("; ")}.` : null;
}

// ─── Link review ─────────────────────────────────────────────────────────────────────────────

export interface ReviewCounts {
  risky: number;
  review: number;
  ok: number;
}

export function reviewSentence({ risky, review, ok }: ReviewCounts, disavowed: number | null): string {
  const total = risky + review + ok;
  if (!total) return "No linking domains to review.";
  const marked = disavowed ? ` ${capitalize(countWord(disavowed))} ${disavowed === 1 ? "is" : "are"} marked disavow.` : "";
  if (risky && review) return `${capitalize(countOf(risky, "domain"))} ${risky === 1 ? "looks" : "look"} risky and ${countWord(review)} ${review === 1 ? "needs" : "need"} review.${marked}`;
  if (risky) return `${capitalize(countOf(risky, "domain"))} ${risky === 1 ? "looks" : "look"} risky.${marked}`;
  if (review) return `${capitalize(countOf(review, "domain"))} ${review === 1 ? "needs" : "need"} review.${marked}`;
  return `Nothing flagged across ${countOf(total, "linking domain")}.${marked}`;
}

export function reviewFigures({ risky, review, ok }: ReviewCounts, disavowed: number | null): FigureData[] {
  return [
    value({ id: "risky", label: "Risky domains", value: formatNumber(risky), caption: "score ≥ 50" }),
    value({ id: "review", label: "To review", value: formatNumber(review), caption: "score 25–49" }),
    value({ id: "ok", label: "OK", value: formatNumber(ok), caption: "score under 25" }),
    disavowed == null
      ? { id: "disavow", label: "Marked disavow", state: "empty", text: "Saved per project, so only for your current project's domain." }
      : value({ id: "disavow", label: "Marked disavow", value: formatNumber(disavowed), caption: "in disavow.txt" }),
  ];
}
