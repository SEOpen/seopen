import { describe, expect, it } from "vitest";
import { decidingRule, isAllowed, parseRobots, rulesFor } from "./robots";

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

describe("decidingRule on a hostile robots.txt", () => {
  const rule = (pattern: string) => ({ allow: false, pattern });

  it("matches many wildcards against a long path in linear time", () => {
    const started = Date.now();
    // As a regex, six of these never finished on a 200-character path.
    expect(decidingRule([rule("/" + "*a".repeat(50) + "*b")], "/" + "a".repeat(500))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
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
  });
});
