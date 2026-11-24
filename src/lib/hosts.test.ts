import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { getRedirectUrl, getRewrittenUrl, isRewrite, unstable_getResponseFromNextConfig } from "next/experimental/testing/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_PREFIXES, isAppPath } from "./hosts";

const APP_DIR = path.join(process.cwd(), "src/app");

/**
 * App prefixes whose folders only getseopen.com has (Billing, Stripe's checkout, portal and webhook
 * routes, and public sign-up's pages). The public tree lacks them, and the proxy listing them there
 * is harmless: the page doesn't exist, so it answers 404.
 */
const CLOUD_ONLY = ["/billing", "/api/billing", "/api/webhooks", "/sign-up", "/set-password", "/verify-email"];

/** Route folders directly under a directory: no files, no private `_folders`, no groups. None when it doesn't exist. */
function routeFolders(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_") && !e.name.startsWith("("))
    .map((e) => e.name);
}

describe("APP_PREFIXES", () => {
  it("lists every app, auth and API folder, and nothing else", () => {
    const expected = [
      ...routeFolders(path.join(APP_DIR, "(app)")).map((f) => `/${f}`),
      ...routeFolders(path.join(APP_DIR, "(admin)")).map((f) => `/${f}`),
      ...routeFolders(path.join(APP_DIR, "(auth)")).map((f) => `/${f}`),
      ...routeFolders(path.join(APP_DIR, "api")).filter((f) => f !== "public").map((f) => `/api/${f}`),
      ...routeFolders(path.join(APP_DIR, ".well-known")).map((f) => `/.well-known/${f}`),
      "/ingest",
      "/login",
    ];
    const listed = APP_PREFIXES.filter((p) => expected.includes(p) || !CLOUD_ONLY.includes(p));
    expect([...listed].sort()).toEqual([...new Set(expected)].sort());
  });

  it("never claims a marketing folder", () => {
    for (const f of routeFolders(path.join(APP_DIR, "(site)"))) expect(isAppPath(`/${f}`)).toBe(false);
  });

  it("matches whole segments only", () => {
    expect(isAppPath("/rank")).toBe(true);
    expect(isAppPath("/rank/x")).toBe(true);
    expect(isAppPath("/rankings")).toBe(false);
    expect(isAppPath("/guide")).toBe(false);
    expect(isAppPath("/docs")).toBe(false);
    expect(isAppPath("/ai-visibility")).toBe(false);
    expect(isAppPath("/api/public/tools/x")).toBe(false);
    expect(isAppPath("/api/auth/get-session")).toBe(true);
  });
});

describe("next.config.ts host rules", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function config(split: boolean) {
    vi.stubEnv("SEOPEN_SITE_HOST", split ? "getseopen.com" : "");
    vi.stubEnv("SEOPEN_APP_HOST", split ? "app.getseopen.com" : "");
    vi.resetModules();
    return (await import("../../next.config")).default;
  }

  const at = async (url: string, split = true) => unstable_getResponseFromNextConfig({ url, nextConfig: await config(split) });

  it("sends app paths on the site host to the app host, keeping the query", async () => {
    const res = await at("https://getseopen.com/api/google/callback?code=abc&state=xyz");
    expect(res.status).toBe(308);
    expect(getRedirectUrl(res)).toBe("https://app.getseopen.com/api/google/callback?code=abc&state=xyz");
    expect(getRedirectUrl(await at("https://getseopen.com/sign-in"))).toBe("https://app.getseopen.com/sign-in");
    expect(getRedirectUrl(await at("https://getseopen.com/rank/settings"))).toBe("https://app.getseopen.com/rank/settings");
    expect(getRedirectUrl(await at("https://getseopen.com/login"))).toBe("https://app.getseopen.com/login");
    expect(getRedirectUrl(await at("https://getseopen.com/.well-known/oauth-authorization-server"))).toBe("https://app.getseopen.com/.well-known/oauth-authorization-server");
  });

  it("keeps marketing paths, unknown paths and the free-tool API on the site host", async () => {
    for (const p of ["/pricing", "/guides/geo-vs-seo", "/no-such-page", "/api/public/tools/x", "/sitemap.xml"]) {
      const res = await at(`https://getseopen.com${p}`);
      expect(getRedirectUrl(res)).toBeNull();
      expect(isRewrite(res)).toBe(false);
    }
  });

  it("shows the landing page at / on the site host and keeps /landing out of results", async () => {
    const res = await at("https://getseopen.com/");
    expect(isRewrite(res)).toBe(true);
    expect(getRewrittenUrl(res)).toBe("https://getseopen.com/landing");
    expect(getRedirectUrl(await at("https://getseopen.com/landing"))).toBe("https://getseopen.com/");
  });

  it("marks every app host response noindex and leaves the site host indexable", async () => {
    expect((await at("https://app.getseopen.com/rank")).headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect((await at("https://getseopen.com/pricing")).headers.get("x-robots-tag")).toBeNull();
  });

  it("stops other sites framing the app host, and leaves the site host alone", async () => {
    for (const p of ["/", "/rank", "/sign-in", "/connect", "/api/mcp"]) {
      const res = await at(`https://app.getseopen.com${p}`);
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
    const site = await at("https://getseopen.com/pricing");
    expect(site.headers.get("content-security-policy")).toBeNull();
    expect(site.headers.get("x-frame-options")).toBeNull();
  });

  it("sends nosniff and a referrer policy on the app host only", async () => {
    for (const p of ["/", "/rank", "/sign-in", "/api/mcp"]) {
      const res = await at(`https://app.getseopen.com${p}`);
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    }
    const site = await at("https://getseopen.com/pricing");
    expect(site.headers.get("x-content-type-options")).toBeNull();
    expect(site.headers.get("referrer-policy")).toBeNull();
  });

  it("sends the security headers on every path of a one-host copy, without noindex", async () => {
    for (const p of ["/", "/rank", "/sign-in", "/pricing", "/api/mcp"]) {
      const res = await at(`http://127.0.0.1:4100${p}`, false);
      expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
      expect(res.headers.get("x-robots-tag")).toBeNull();
    }
  });

  it("still drops trailing slashes, except on PostHog's /ingest API", async () => {
    for (const split of [true, false]) {
      const origin = split ? "https://getseopen.com" : "https://preview.seopen.example";
      const res = await at(`${origin}/pricing/?a=1`, split);
      expect(res.status).toBe(308);
      expect(getRedirectUrl(res)).toBe(`${origin}/pricing?a=1`);
    }
    expect(getRedirectUrl(await at("https://preview.seopen.example/pricing", false))).toBeNull();
    expect(getRedirectUrl(await at("https://preview.seopen.example/", false))).toBeNull();
    const ingest = await at("https://preview.seopen.example/ingest/e/", false);
    expect(getRedirectUrl(ingest)).toBeNull();
    expect(isRewrite(ingest)).toBe(true);
    // Rewrites drop the slash on the way out; PostHog takes /e and /e/ alike. What matters is no 308.
    expect(getRewrittenUrl(ingest)).toBe("https://us.i.posthog.com/e");
    expect(getRewrittenUrl(await at("https://preview.seopen.example/ingest/static/array.js", false))).toBe("https://us-assets.i.posthog.com/static/array.js");
  });

  it("relays analytics to PostHog on both hosts", async () => {
    const site = await at("https://getseopen.com/ingest/e/");
    expect(getRedirectUrl(site)).toBeNull();
    expect(getRewrittenUrl(site)).toBe("https://us.i.posthog.com/e");
    expect(getRewrittenUrl(await at("https://app.getseopen.com/ingest/flags/?v=2"))).toBe("https://us.i.posthog.com/flags?v=2");
  });

  it("adds no host rules on one host", async () => {
    expect(getRedirectUrl(await at("https://preview.seopen.example/rank", false))).toBeNull();
    expect(isRewrite(await at("https://preview.seopen.example/", false))).toBe(false);
    expect(getRedirectUrl(await at("https://preview.seopen.example/login", false))).toBe("https://preview.seopen.example/sign-in");
  });
});
