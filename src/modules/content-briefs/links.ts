import type { LinkSuggestion, Source } from "./types";

/**
 * Internal link suggestions from the project's own data, pure: pages that already show up in Search
 * Console for searches on the topic should link to the new page, and related pages from the latest
 * site audit are ones it should link to.
 */

const STOPWORDS = new Set("a an and are as at be best by can do does for from how i in is it my of on or the to vs versus what when where which who why will with you your".split(" "));

/**
 * Words that say what kind of thing, not which: "free rank checker" shares only "free" and "checker" with
 * "free backlink checker", and isn't on its topic.
 */
const MODIFIERS = new Set("free online top cheap easy simple quick new tool tools".split(" "));

/** The words that carry a keyword's meaning: modifiers such as "free" and "online" left out, unless that leaves none. */
export function topicTerms(keyword: string): string[] {
  const all = [...new Set(keyword.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOPWORDS.has(w)))];
  const core = all.filter((w) => !MODIFIERS.has(w));
  return core.length ? core : all;
}

const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** How many of the terms the text has as whole words. */
export function termHits(text: string, terms: string[]): number {
  const w = words(text);
  return terms.filter((t) => w.has(t)).length;
}

/** On topic: every term for a one- or two-word topic, otherwise at least half of them. */
export const onTopic = (text: string, terms: string[]) => terms.length > 0 && termHits(text, terms) >= (terms.length <= 2 ? terms.length : Math.ceil(terms.length / 2));

export interface GscPair {
  query: string;
  page: string;
  clicks: number;
  impressions: number;
  position: number;
}

export interface AuditPage {
  url: string;
  title: string | null;
  h1: string | null;
  statusCode: number | null;
  indexable: boolean | null;
  internalLinksIn: number | null;
}

export interface LinkInput {
  keyword: string;
  gsc: { pairs: GscPair[]; source: Source } | null;
  audit: { pages: AuditPage[]; source: Source } | null;
}

const MAX_FROM = 6;
const MAX_TO = 5;
const fmt = (n: number) => n.toLocaleString("en-US");
const impressionsOf = (n: number) => `${fmt(n)} ${n === 1 ? "impression" : "impressions"}`;
const bare = (url: string) => url.replace(/[#?].*$/, "").replace(/\/+$/, "").toLowerCase();

export function linkSuggestions(input: LinkInput): { from: LinkSuggestion[]; to: LinkSuggestion[]; note: string | null } {
  const terms = topicTerms(input.keyword);
  const exact = input.keyword.trim().toLowerCase();
  const from: LinkSuggestion[] = [];
  const taken = new Set<string>();
  let note: string | null = null;

  if (input.gsc) {
    const byPage = new Map<string, { impressions: number; top: GscPair }>();
    for (const p of input.gsc.pairs) {
      if (!onTopic(p.query, terms)) continue;
      const cur = byPage.get(p.page);
      if (!cur) byPage.set(p.page, { impressions: p.impressions, top: p });
      else {
        cur.impressions += p.impressions;
        if (p.impressions > cur.top.impressions) cur.top = p;
      }
    }
    const ranked = [...byPage.entries()].sort((a, b) => b[1].impressions - a[1].impressions);
    const already = input.gsc.pairs.filter((p) => p.query.toLowerCase() === exact).sort((a, b) => b.impressions - a.impressions)[0];
    if (already) note = `${already.page} already shows for “${already.query}” at position ${already.position} (${impressionsOf(already.impressions)}). Extending that page may do better than a new one.`;
    for (const [page, { impressions, top }] of ranked.slice(0, MAX_FROM)) {
      taken.add(bare(page));
      from.push({ url: page, why: `Shows for “${top.query}” at position ${top.position}; ${impressionsOf(impressions)} on the topic.`, source: input.gsc.source });
    }
  }

  const to: LinkSuggestion[] = [];
  if (input.audit) {
    const live = input.audit.pages.filter((p) => p.statusCode === 200 && p.indexable !== false && !taken.has(bare(p.url)));
    const text = (p: AuditPage) => `${p.title ?? ""} ${p.h1 ?? ""}`;
    const byLinks = (a: AuditPage, b: AuditPage) => (b.internalLinksIn ?? 0) - (a.internalLinksIn ?? 0) || a.url.localeCompare(b.url);
    for (const p of live.filter((p) => onTopic(text(p), terms)).sort(byLinks)) {
      if (from.length >= MAX_FROM) break;
      taken.add(bare(p.url));
      from.push({ url: p.url, why: `Its title or H1 is on the topic: “${p.title ?? p.h1}”.`, source: input.audit.source });
    }
    for (const p of live.filter((p) => !taken.has(bare(p.url)) && termHits(text(p), terms) > 0).sort(byLinks).slice(0, MAX_TO)) {
      to.push({ url: p.url, why: `A related page: “${p.title ?? p.h1 ?? p.url}”${p.internalLinksIn ? `, with ${fmt(p.internalLinksIn)} internal ${p.internalLinksIn === 1 ? "link" : "links"} to it` : ""}.`, source: input.audit.source });
    }
  }

  if (!input.gsc && !input.audit) note = "There's no Search Console data or finished site audit for this project yet, so there are no internal link suggestions.";
  else if (!from.length && !to.length) note ??= "Nothing in Search Console or the latest site audit is on this topic yet.";
  return { from, to, note };
}
