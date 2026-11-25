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

/** The rules a crawler with this product token obeys, and whether a group named it. */
export function rulesFor(robots: Robots, token: string): { rules: RobotsRule[]; named: boolean } {
  const t = token.toLowerCase();
  const named = robots.groups.filter((g) => g.agents.includes(t));
  if (named.length) return { rules: named.flatMap((g) => g.rules), named: true };
  return { rules: robots.groups.filter((g) => g.agents.includes("*")).flatMap((g) => g.rules), named: false };
}

/**
 * Whether a robots.txt path pattern matches `path`: `*` matches anything, a trailing `$` anchors
 * the end. Matched part by part with indexOf, taking each part at its first place: as a regex, each
 * `*` became `.*`, and a site's own `Disallow: /*a*a*a*a*a*a*b` backtracked for minutes on one path.
 */
function patternMatches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith("$");
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const first = parts[0];
  if (parts.length === 1) return anchored ? path === first : path.startsWith(first);
  if (!path.startsWith(first)) return false;
  let at = first.length;
  for (const part of parts.slice(1, -1)) {
    const found = path.indexOf(part, at);
    if (found < 0) return false;
    at = found + part.length;
  }
  const last = parts.at(-1)!;
  return anchored ? path.length - last.length >= at && path.endsWith(last) : path.indexOf(last, at) >= 0;
}

/** Percent-encode what a crawler would, so "/café" and "/caf%C3%A9" compare equal. */
function canonicalPath(path: string): string {
  try {
    return encodeURI(decodeURI(path));
  } catch {
    return path;
  }
}

/** The rule that decides `path`, or null when none matches (allowed). */
export function decidingRule(rules: RobotsRule[], path: string): RobotsRule | null {
  const p = canonicalPath(path || "/");
  let best: RobotsRule | null = null;
  for (const r of rules) {
    if (!patternMatches(canonicalPath(r.pattern), p)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
  }
  return best;
}

export function isAllowed(robots: Robots, token: string, path: string): boolean {
  return decidingRule(rulesFor(robots, token).rules, path)?.allow ?? true;
}
