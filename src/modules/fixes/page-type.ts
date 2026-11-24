import { classifyResult, serpMix, type SerpMix } from "@/modules/content-briefs/serp-type";
import type { SerpType } from "@/modules/content-briefs/types";

/**
 * What kind of page ranks for a search, set against the project's own page for it.
 * The `serp` tool and the `gsc-wrong-page-type` fix both read it. The rules are content briefs'
 * (`classifyResult` and `serpMix`, unchanged); this file only says what each result was classified from,
 * and when a call about the project's own page is too shaky to act on. Pure, so it is unit tested.
 */

/** One result as a saved results page has it. */
export interface ResultInput {
  type: string;
  url: string | null;
  domain: string | null;
  title: string | null;
  /**
   * True when Google hid the real link and `url` is only the site's origin (`serpTarget`). "unknown"
   * for a source that kept the origin but not the flag (the daily rank check's top 20).
   */
  originOnly: boolean | "unknown";
  /** Google's display path for an origin-only result, which may be cut short. */
  breadcrumb: string | null;
}

export interface Classified {
  type: SerpType | null;
  why: string;
}

/** The kinds of result that count toward the top 10's page type, as in content briefs. */
export const COUNTED = new Set(["organic", "video"]);

const HOME = "a site's home page";

/**
 * An origin-only result's address rebuilt from Google's display path, so the address rules have a
 * path to read. Null when the path was cut short or is missing.
 */
function displayAddress(origin: string, breadcrumb: string): string | null {
  const parts = breadcrumb.split("›").map((s) => s.trim());
  if (!parts.length || parts.some((p) => !p || /\.\.\.|…/.test(p))) return null;
  try {
    return new URL(`/${parts.map(encodeURIComponent).join("/")}/`, origin).toString();
  } catch {
    return null;
  }
}

/** One result's page type, and what it was read from. */
export function classifyRow(r: ResultInput): Classified {
  const domain = r.domain;
  // A result with no address and no site (a hidden link with no display path) says nothing to classify.
  if (!r.url && !domain) return { type: null, why: "Google gave no address for this result" };
  if (r.originOnly === true && r.url && r.breadcrumb) {
    const address = displayAddress(r.url, r.breadcrumb);
    const kind = classifyResult({ type: r.type, url: address, domain, title: r.title });
    // Google's display path names a page under the origin, so it isn't the home page.
    if (kind.why === HOME || (!address && !kind.type)) return { type: null, why: "Google hid its address and its title names no kind of page" };
    return { type: kind.type, why: address ? `${kind.why}, reading the address from Google's display path` : kind.why };
  }
  const kind = classifyResult({ type: r.type, url: r.url, domain, title: r.title });
  // A bare origin from a source that dropped the flag may be any page Google hid the address of.
  if (r.originOnly === "unknown" && kind.why === HOME) return { type: null, why: "only the site's address was saved, so it may not be the home page" };
  if (r.originOnly === true && kind.why === HOME) return { type: kind.type, why: `${HOME}, from Google's display of the bare site address` };
  return kind;
}

/**
 * Each result's page type (null for a result that doesn't count, such as People also ask), and the
 * top 10's mix: organic and video results, in page order, as content briefs count them.
 */
export function pageTypes(rows: readonly ResultInput[]): { kinds: (Classified | null)[]; mix: SerpMix } {
  const kinds = rows.map((r) => (COUNTED.has(r.type) ? classifyRow(r) : null));
  const counted = rows.flatMap((r, i) => (kinds[i] ? [{ type: kinds[i].type, url: r.url }] : [])).slice(0, 10);
  return { kinds, mix: serpMix(counted) };
}

/** A dominant type Google has settled on: one type leads, and enough of the top 10 agree. */
export const settledType = (mix: SerpMix): SerpType | null => (mix.dominant && !mix.warning ? mix.dominant : null);

export interface OwnPageType {
  type: SerpType | null;
  why: string;
  /** False when the title and address disagree, or only the title says what it is, so no mismatch is reported. */
  reliable: boolean;
}

/**
 * The project's own page type, from its address and the title SEOpen's latest audit saw. A title is
 * the trap: a feature page titled "Backlink checker and explorer: who links to you" reads as a tool,
 * because a page about a tool names the tool. So a call only counts when the address agrees with the
 * title, or the title alone says something a page about the thing wouldn't (a guide, a list).
 */
export function ownPageType(url: string, title: { text: string; from: string } | null): OwnPageType {
  const domain = hostOf(url);
  const fromAddress = classifyResult({ type: "organic", url, domain, title: null });
  if (!title?.text) {
    const only = "from its address only, as SEOpen's latest site audit doesn't have this page's title";
    return fromAddress.type ? { type: fromAddress.type, why: `${fromAddress.why}, ${only}`, reliable: true } : { type: null, why: `its address doesn't say what kind of page it is, and SEOpen's latest site audit doesn't have its title`, reliable: false };
  }
  const said = `its title “${title.text}” (${title.from})`;
  const full = classifyResult({ type: "organic", url, domain, title: title.text });
  if (!full.type) return { type: null, why: `no rule matched ${said} or its address`, reliable: false };
  if (fromAddress.type === full.type) return { type: full.type, why: `${full.why}: ${said} and its address agree`, reliable: true };
  if (fromAddress.type) return { type: full.type, why: `${said} reads as ${NOUN[full.type].one}, but its address reads as ${NOUN[fromAddress.type].one}`, reliable: false };
  if (full.type === "tool") return { type: full.type, why: `${said} names a tool, but its address doesn't show it is one, so it may be a page about a tool`, reliable: false };
  return { type: full.type, why: `${full.why}, from ${said}`, reliable: true };
}

/** "tools", "a tool": how a page type reads in a sentence. */
export const NOUN: Record<SerpType, { one: string; many: string }> = {
  guide: { one: "a guide or article", many: "guides or articles" },
  product: { one: "a product or service page", many: "product or service pages" },
  comparison: { one: "a comparison", many: "comparisons" },
  list: { one: "a list", many: "lists" },
  tool: { one: "a tool", many: "tools" },
  video: { one: "a video", many: "videos" },
};

/**
 * "7 of the top 10 are tools; your page is a product or service page." Only when Google has settled
 * on a type, the call about the project's page holds up, and the two differ.
 */
export function mismatchLine(mix: SerpMix, own: OwnPageType | null): string | null {
  const dominant = settledType(mix);
  if (!dominant || !own?.reliable || !own.type || own.type === dominant) return null;
  return `${mix.agree} of the top ${Math.min(mix.total, 10)} are ${NOUN[dominant].many}; your page is ${NOUN[own.type].one}.`;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
