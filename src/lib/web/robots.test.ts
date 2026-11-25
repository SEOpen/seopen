import { describe, expect, it } from "vitest";
import { crawlerAccess } from "./crawlers";
import { decidingRule, isAllowed, parseRobots, pathRules, rulesFor } from "./robots";

describe("parseRobots", () => {
  it("groups consecutive user-agent lines and collects sitemaps", () => {
    const r = parseRobots("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin # private\nSitemap: https://x.com/sitemap.xml");
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0].agents).toEqual(["gptbot", "ccbot"]);
    expect(r.groups[1].rules).toEqual([{ allow: false, pattern: "/admin" }]);
    expect(r.sitemaps).toEqual(["https://x.com/sitemap.xml"]);
  });

  it("keeps a value's own colons and skips a line whose key isn't one", () => {
    const r = parseRobots("User-agent : *\nDisallow: /a:b#c:d\n# Disallow: /x\nnot a key: /y\nno colon");
    expect(r.groups).toEqual([{ agents: ["*"], rules: [{ allow: false, pattern: "/a:b" }] }]);
  });

  it("reads 500 KB lines in linear time", () => {
    const run = " ".repeat(500_000);
    const started = Date.now();
    for (const text of [`${"#".repeat(500_000)}\u2028x`, `Sitemap:${run}x\u2028x`, `a${run}b`, `${"a".repeat(500_000)} `]) parseRobots(text);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("treats an empty Disallow as allow everything", () => {
    const r = parseRobots("User-agent: *\nDisallow:");
    expect(isAllowed(r, "Googlebot", "/")).toBe(true);
  });
});

describe("rulesFor", () => {
  const r = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /");
  it("uses the group naming the crawler over the * group", () => {
    expect(rulesFor(r, "OAI-SearchBot")).toEqual({ rules: [{ allow: true, pattern: "/" }], named: true });
    expect(isAllowed(r, "OAI-SearchBot", "/page")).toBe(true);
  });
  it("falls back to * for crawlers not named", () => {
    expect(rulesFor(r, "GPTBot").named).toBe(false);
    expect(isAllowed(r, "GPTBot", "/page")).toBe(false);
  });
});

describe("decidingRule", () => {
  it("picks the longest match, allow winning a tie", () => {
    const rules = [
      { allow: false, pattern: "/docs" },
      { allow: true, pattern: "/docs/public" },
    ];
    expect(decidingRule(rules, "/docs/public/a")?.allow).toBe(true);
    expect(decidingRule(rules, "/docs/private")?.allow).toBe(false);
    expect(decidingRule([{ allow: false, pattern: "/a" }, { allow: true, pattern: "/a" }], "/a")?.allow).toBe(true);
  });
  it("supports * and the $ end anchor", () => {
    const rules = [{ allow: false, pattern: "/*.pdf$" }];
    expect(decidingRule(rules, "/files/a.pdf")).not.toBeNull();
    expect(decidingRule(rules, "/files/a.pdf?x=1")).toBeNull();
  });
  it("returns null when nothing matches", () => {
    expect(decidingRule([{ allow: false, pattern: "/private" }], "/")).toBeNull();
  });
});

describe("pathRules", () => {
  it("reads a crawler's groups together: the longest rule, allow on a tie, the first of equals", () => {
    const r = parseRobots("User-agent: GPTBot\nUser-agent: CCBot\nDisallow: /blog\nUser-agent: CCBot\nAllow: /blog\nUser-agent: GPTBot\nDisallow: /blog/\nUser-agent: *\nDisallow: /blog/post");
    const ruleFor = pathRules(r, "/blog/post");
    expect(ruleFor("GPTBot")).toEqual({ rule: { allow: false, pattern: "/blog/" }, named: true });
    expect(ruleFor("CCBot")).toEqual({ rule: { allow: true, pattern: "/blog" }, named: true });
    expect(ruleFor("Bingbot")).toEqual({ rule: { allow: false, pattern: "/blog/post" }, named: false });
    for (const token of ["GPTBot", "CCBot", "Bingbot"]) expect(ruleFor(token).rule).toBe(decidingRule(rulesFor(r, token).rules, "/blog/post"));
  });
});

describe("decidingRule on a hostile robots.txt", () => {
  const rule = (pattern: string) => ({ allow: false, pattern });

  it("matches many wildcards against a long path in linear time", () => {
    const started = Date.now();
    expect(decidingRule([rule("/" + "*a".repeat(50) + "*b")], "/" + "a".repeat(500))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("decides a 500 KB file for five long paths and every crawler", () => {
    const file = (line: (i: number) => string) => {
      const lines: string[] = [];
      for (let size = 0, i = 0; size < 500_000; size += lines[i++].length) lines.push(line(i));
      return `User-agent: *\n${lines.join("")}`;
    };
    const long = "a".repeat(2_000);
    const files = {
      "many wildcards": file((i) => `Disallow:/*a*a*a*a${i}\n`),
      "short rules": file(() => "Disallow:/*b\n"),
      "long parts": file((i) => `Disallow:/*${"a".repeat((i % 1_900) + 1)}*b\n`),
      "bad escapes": file(() => "Disallow:/é%\n"),
      "many groups": file((i) => `User-agent: *\nDisallow:/*a${i}b\n`),
    };
    for (const [name, text] of Object.entries(files)) {
      const robots = parseRobots(text);
      const started = Date.now();
      for (let i = 0; i < 5; i++) for (const c of crawlerAccess(robots, `/${long}x${i}`)) expect(c.allowed).toBe(true);
      // About 40 ms on a laptop.
      expect(Date.now() - started, name).toBeLessThan(3000);
    }
  });

  it("finds a part of any length at its first place after the one before", () => {
    const path = "/aaaab-aaaac-aaaab-aaaad-caf%C3%A9-aaaab";
    const hits = (pattern: string) => decidingRule([rule(pattern)], path) !== null;
    expect(["/*aaaab*aaaab*aaaab", "/*aaaab*aaaab*aaaab$", "/*aaaac-*-aaaad", "/*café-", "/**-aaaa*$", "/*aaab-aaaac-aaaab-aaaad"].filter((p) => !hits(p))).toEqual([]);
    expect(["/*aaaab*aaaab*aaaab*aaaab", "/*aaaad*aaaac", "/*aaaaa", "/*aaaad$", "/*aaaab*aaaab*aaaab*b$", "/*aaab-aaaad-aaaab"].filter(hits)).toEqual([]);
  });

  it("matches as the old regex did", () => {
    const regex = (pattern: string) => {
      const anchored = pattern.endsWith("$");
      const body = (anchored ? pattern.slice(0, -1) : pattern).split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
      return new RegExp(`^${body}${anchored ? "$" : ""}`);
    };
    const pick = (alphabet: string, n: number, r: () => number) => Array.from({ length: n }, () => alphabet[Math.floor(r() * alphabet.length)]).join("");
    let seed = 7;
    const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 20_000; i++) {
      const pattern = "/" + pick("ab*$?", Math.floor(r() * 6), r);
      const path = "/" + pick("ab$?", Math.floor(r() * 8), r);
      expect(decidingRule([rule(pattern)], path) !== null, `${pattern} on ${path}`).toBe(regex(pattern).test(path));
    }
    // Longer parts, many rules to a path: what one rule found mustn't change another's answer.
    for (let i = 0; i < 1_000; i++) {
      const path = "/" + pick("ab", 60, r);
      const parts = Array.from({ length: 4 }, () => pick("ab", 5 + Math.floor(r() * 3), r));
      const patterns = Array.from({ length: 12 }, () => "/*" + Array.from({ length: 1 + Math.floor(r() * 3) }, () => parts[Math.floor(r() * 4)]).join("*"));
      const longest = patterns.filter((p) => regex(p).test(path)).reduce<string | null>((best, p) => (best === null || p.length > best.length ? p : best), null);
      expect(decidingRule(patterns.map(rule), path)?.pattern ?? null, `${patterns.join(" ")} on ${path}`).toBe(longest);
    }
  });
});
