/**
 * robots.txt as crawlers read it (RFC 9309, which Google follows): a crawler obeys the groups
 * naming its product token, or the `*` groups when none does; the longest matching rule wins,
 * and `allow` wins a tie. Pure functions, no I/O.
 */

export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface Robots {
  groups: RobotsGroup[];
  sitemaps: string[];
}

export function parseRobots(text: string): Robots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  // A run of user-agent lines opens one group; the first rule after them closes the run.
  let collectingAgents = false;
  for (const raw of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    // Cut at the first "#" and the first ":" by position: the file is any site's, and a pattern over a whole line can backtrack.
    const hash = raw.indexOf("#");
    const line = hash < 0 ? raw : raw.slice(0, hash);
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (!/^[a-z-]+$/.test(key)) continue;
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (!collectingAgents || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      collectingAgents = true;
    } else if (key === "allow" || key === "disallow") {
      collectingAgents = false;
      if (!current) continue;
      // An empty disallow allows everything; it adds no rule.
      if (key === "disallow" && !value) continue;
      if (key === "allow" && !value) continue;
      current.rules.push({ allow: key === "allow", pattern: value });
    } else if (key === "sitemap") {
      if (value) sitemaps.push(value);
    } else {
      collectingAgents = false;
    }
  }
  return { groups, sitemaps };
}

/** The groups a crawler with this product token obeys, and whether one named it. */
function groupsFor(robots: Robots, token: string): { groups: RobotsGroup[]; named: boolean } {
  const t = token.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.includes(t));
  return named.length ? { groups: named, named: true } : { groups: robots.groups.filter((g) => g.agents.includes("*")), named: false };
}

/** The rules a crawler with this product token obeys, and whether a group named it. */
export function rulesFor(robots: Robots, token: string): { rules: RobotsRule[]; named: boolean } {
  const { groups, named } = groupsFor(robots, token);
  return { rules: groups.flatMap((g) => g.rules), named };
}

/** Percent-encode what a crawler would, so "/café" and "/caf%C3%A9" compare equal. */
function canonicalPath(path: string): string {
  try {
    return encodeURI(decodeURI(path));
  } catch {
    return path;
  }
}

/** A rule's pattern, cut at each `*`. `anchored` by a trailing `$`. */
interface ReadyRule {
  rule: RobotsRule;
  parts: string[];
  anchored: boolean;
}

/** Each list of rules, ready to match. A list isn't changed once its file is parsed, and is the same for every path and crawler. */
const ready = new WeakMap<RobotsRule[], ReadyRule[]>();

function readyRules(rules: RobotsRule[]): ReadyRule[] {
  let out = ready.get(rules);
  if (!out) {
    out = rules.map((rule) => {
      const pattern = canonicalPath(rule.pattern);
      const anchored = pattern.endsWith("$");
      return { rule, parts: (anchored ? pattern.slice(0, -1) : pattern).split("*"), anchored };
    });
    ready.set(rules, out);
  }
  return out;
}

/** The longest run of characters a path's index holds. */
const GRAM = 4;

/** The first place in `places` at or after `from`, as an index into it. */
function firstAfter(places: number[], from: number): number {
  let [lo, hi] = [0, places.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (places[mid] < from) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * A path that thousands of rules look for their parts in. It keeps where each run of up to `GRAM`
 * characters is, so a part that isn't there costs a lookup, not another read of the path, and it
 * remembers its last answer for each longer part.
 */
class PathText {
  private grams: Map<string, number[]> | null = null;
  private answers = new Map<string, { from: number; found: number }>();

  constructor(readonly text: string) {}

  /** As `text.indexOf(part, from)`. */
  indexOf(part: string, from: number): number {
    if (!part) return from;
    this.grams ??= this.index();
    if (part.length <= GRAM) {
      const places = this.grams.get(part) ?? [];
      return places[firstAfter(places, from)] ?? -1;
    }
    const last = this.answers.get(part);
    if (last && from >= last.from && (last.found < 0 || from <= last.found)) return last.found;
    const found = this.longIndexOf(part, from, this.grams);
    this.answers.set(part, { from, found });
    return found;
  }

  /** A part longer than `GRAM` is looked for at its rarest run, when the path has all of them. */
  private longIndexOf(part: string, from: number, grams: Map<string, number[]>): number {
    let rarest: number[] | null = null;
    let offset = 0;
    for (let i = 0; i < part.length; i += GRAM) {
      const at = Math.min(i, part.length - GRAM);
      const places = grams.get(part.slice(at, at + GRAM));
      if (!places) return -1;
      if (!rarest || places.length < rarest.length) [rarest, offset] = [places, at];
    }
    if (!rarest) return -1;
    for (let i = firstAfter(rarest, from + offset); i < rarest.length; i++) {
      if (this.text.startsWith(part, rarest[i] - offset)) return rarest[i] - offset;
    }
    return -1;
  }

  private index(): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (let n = 1; n <= GRAM; n++) {
      for (let i = 0; i + n <= this.text.length; i++) {
        const gram = this.text.slice(i, i + n);
        const places = out.get(gram);
        if (places) places.push(i);
        else out.set(gram, [i]);
      }
    }
    return out;
  }
}

/**
 * Whether a robots.txt path pattern matches `path`: `*` matches anything, a trailing `$` anchors
 * the end. Matched part by part, taking each part at its first place, so there's no backtracking.
 */
function patternMatches({ parts, anchored }: ReadyRule, path: PathText): boolean {
  const { text } = path;
  const first = parts[0];
  if (parts.length === 1) return anchored ? text === first : text.startsWith(first);
  if (!text.startsWith(first)) return false;
  let at = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const found = path.indexOf(parts[i], at);
    if (found < 0) return false;
    at = found + parts[i].length;
  }
  const last = parts[parts.length - 1];
  return anchored ? text.length - last.length >= at && text.endsWith(last) : path.indexOf(last, at) >= 0;
}

/** Whether `a` decides over `b`, an earlier rule: the longer pattern, and `allow` on a tie. */
const decidesOver = (a: RobotsRule, b: RobotsRule | null) => !b || a.pattern.length > b.pattern.length || (a.pattern.length === b.pattern.length && a.allow && !b.allow);

function decide(rules: RobotsRule[], path: PathText): RobotsRule | null {
  let best: RobotsRule | null = null;
  for (const r of readyRules(rules)) if (decidesOver(r.rule, best) && patternMatches(r, path)) best = r.rule;
  return best;
}

const pathText = (path: string) => new PathText(canonicalPath(path || "/"));

/** The rule that decides `path`, or null when none matches (allowed). */
export function decidingRule(rules: RobotsRule[], path: string): RobotsRule | null {
  return decide(rules, pathText(path));
}

/** The rule that decides `path` for each crawler asked about. Each group is read once, however many crawlers obey it. */
export function pathRules(robots: Robots, path: string): (token: string) => { rule: RobotsRule | null; named: boolean } {
  const text = pathText(path);
  const decided = new Map<RobotsGroup, RobotsRule | null>();
  return (token) => {
    const { groups, named } = groupsFor(robots, token);
    let rule: RobotsRule | null = null;
    for (const g of groups) {
      let best = decided.get(g);
      if (best === undefined) decided.set(g, (best = decide(g.rules, text)));
      if (best && decidesOver(best, rule)) rule = best;
    }
    return { rule, named };
  };
}

export function isAllowed(robots: Robots, token: string, path: string): boolean {
  return pathRules(robots, path)(token).rule?.allow ?? true;
}
