import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiCitation } from "@/db/schema/ai";

const safeFetch = vi.fn();
vi.mock("@/lib/web/fetch", () => ({ safeFetch: (...args: unknown[]) => safeFetch(...args) }));

const { geminiLinks, lookUpRedirect, redirectTarget } = await import("./gemini-links");
const { readCitation } = await import("./detect");

const redirect = (id: string) => `https://vertexaisearch.cloud.google.com/grounding-api-redirect/${id}`;
const gemini = (id: string, title: string | null): AiCitation => ({ url: redirect(id), domain: title ?? "vertexaisearch.cloud.google.com", title });

beforeEach(() => safeFetch.mockReset());

describe("redirectTarget", () => {
  it("keeps an http(s) page, without tracking params", () => {
    expect(redirectTarget("https://shopfinder.example/best-mugs?utm_source=gemini#top", redirect("A"))).toBe("https://shopfinder.example/best-mugs");
  });

  it("refuses what isn't a page worth storing", () => {
    expect(redirectTarget(undefined, redirect("A"))).toBeNull();
    expect(redirectTarget("javascript:alert(1)", redirect("A"))).toBeNull();
    expect(redirectTarget("ftp://files.example/a", redirect("A"))).toBeNull();
    expect(redirectTarget("https://user:pw@shopfinder.example/", redirect("A"))).toBeNull();
    expect(redirectTarget("http://intranet/", redirect("A"))).toBeNull();
    expect(redirectTarget(`https://shopfinder.example/${"a".repeat(2100)}`, redirect("A"))).toBeNull();
    // A relative Location stays on Google's redirect host, which isn't the page.
    expect(redirectTarget("/grounding-api-redirect/B", redirect("A"))).toBeNull();
  });
});

describe("lookUpRedirect", () => {
  it("asks the redirect once, follows nothing and reads only the headers", async () => {
    safeFetch.mockResolvedValue({ status: 302, headers: { location: "https://shopfinder.example/best-mugs" } });
    expect(await lookUpRedirect(redirect("A"))).toBe("https://shopfinder.example/best-mugs");
    expect(safeFetch).toHaveBeenCalledWith(redirect("A"), expect.objectContaining({ headOnly: true, maxRedirects: 0 }));
  });

  it("gives null when the redirect has expired, errs or is refused", async () => {
    safeFetch.mockResolvedValueOnce({ status: 404, headers: {} });
    expect(await lookUpRedirect(redirect("A"))).toBeNull();
    safeFetch.mockRejectedValueOnce(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    expect(await lookUpRedirect(redirect("B"))).toBeNull();
    safeFetch.mockResolvedValueOnce({ status: 302, headers: {} });
    expect(await lookUpRedirect(redirect("C"))).toBeNull();
  });
});

describe("geminiLinks", () => {
  const pages: Record<string, string> = {
    [redirect("A")]: "https://shopfinder.example/best-mugs",
    [redirect("B")]: "https://www.mugreview.example/guide",
    [redirect("D")]: "https://shopfinder.example/best-mugs",
  };
  const lookUp = vi.fn(async (url: string) => pages[url] ?? null);
  beforeEach(() => lookUp.mockClear());

  it("stores each redirect under its page, keeping a title that isn't just the site's name", async () => {
    const out = await geminiLinks({ lookUp }).resolve([
      { url: "https://plain.example/a", domain: "plain.example", title: "Plain" },
      gemini("A", "shopfinder.example"),
      gemini("B", "The mug guide"),
    ]);
    expect(out).toEqual([
      { url: "https://plain.example/a", domain: "plain.example", title: "Plain" },
      { url: "https://shopfinder.example/best-mugs", domain: "shopfinder.example", title: null },
      { url: "https://www.mugreview.example/guide", domain: "mugreview.example", title: "The mug guide" },
    ]);
    expect(out.every((c) => !readCitation(c).gemini)).toBe(true);
  });

  it("keeps a redirect it can't follow as Gemini gave it, still filed under its title's site", async () => {
    const [c] = await geminiLinks({ lookUp }).resolve([gemini("Z", "lostsite.example")]);
    expect(c).toEqual(gemini("Z", "lostsite.example"));
    expect(readCitation(c)).toMatchObject({ gemini: true, domain: "lostsite.example" });
  });

  it("dedupes two redirects that lead to one page", async () => {
    const out = await geminiLinks({ lookUp }).resolve([gemini("A", "shopfinder.example"), gemini("D", "shopfinder.example")]);
    expect(out.map((c) => c.url)).toEqual(["https://shopfinder.example/best-mugs"]);
  });

  it("looks each redirect up once and stops at the run's cap", async () => {
    const links = geminiLinks({ lookUp, maxLookups: 2 });
    await links.resolve([gemini("A", null)]);
    await links.resolve([gemini("A", null), gemini("B", null)]);
    const last = await links.resolve([gemini("D", "shopfinder.example")]);
    expect(lookUp).toHaveBeenCalledTimes(2);
    expect(links.lookups).toBe(2);
    expect(last).toEqual([gemini("D", "shopfinder.example")]);
  });

  it("makes no lookup for an answer without redirects, and survives a lookup that throws", async () => {
    const plain = [{ url: "https://plain.example/a", domain: "plain.example", title: null }];
    expect(await geminiLinks({ lookUp }).resolve(plain)).toBe(plain);
    expect(lookUp).not.toHaveBeenCalled();
    const broken = geminiLinks({ lookUp: async () => Promise.reject(new Error("boom")) });
    expect(await broken.resolve([gemini("A", null)])).toEqual([gemini("A", null)]);
  });
});
