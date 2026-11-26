import { NextRequest } from "next/server";
import { getRedirectUrl, isRewrite, unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appHref, siteHref } from "@/lib/hosts";
import { config, proxy } from "./proxy";

// Better Auth needs the database; the proxy only cares whether getSession finds a session.
const getSession = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ auth: { api: { getSession } } }));
const storeCookie = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies: async () => ({ set: storeCookie }) }));
// Its query has its own test in src/lib/workspace/live-project.db.test.ts.
const isLiveProject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace/current", () => ({ isLiveProject }));

const BETTER_AUTH_COOKIE = "__Secure-better-auth.session_token";

function get(url: string, as: "stranger" | "account" = "stranger", currentProject?: string) {
  const request = new NextRequest(url);
  if (as === "account") request.cookies.set(BETTER_AUTH_COOKIE, "token.signature");
  if (currentProject) request.cookies.set("seopen_project", currentProject);
  return proxy(request);
}

/** Makes getSession find a session, optionally refreshing a cookie. */
function signedIn(setCookie?: string) {
  const headers = new Headers();
  if (setCookie) headers.append("set-cookie", setCookie);
  getSession.mockResolvedValue({ headers, response: { user: { id: "u1" }, session: { id: "s1" } } });
}

beforeEach(() => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("SEOPEN_SITE_HOST", "");
  vi.stubEnv("SEOPEN_APP_HOST", "");
  getSession.mockReset();
  getSession.mockResolvedValue({ headers: new Headers(), response: null });
  isLiveProject.mockReset();
  isLiveProject.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

describe("one host (hosts not split)", () => {
  it("keeps the dashboard at / behind sign-in", async () => {
    expect(getRedirectUrl(await get("https://getseopen.com/"))).toBe("https://getseopen.com/sign-in");
    signedIn();
    expect((await get("https://getseopen.com/", "account")).status).toBe(200);
  });

  it("needs an account locally too", async () => {
    vi.stubEnv("VERCEL", "");
    expect(getRedirectUrl(await get("http://localhost:4100/rank"))).toBe("http://localhost:4100/sign-in?next=%2Frank");
  });

  it("serves marketing pages, crawler files and auth pages without a session", async () => {
    for (const path of ["/landing", "/pricing", "/privacy", "/terms", "/guides/x", "/no-such-page", "/robots.txt", "/sitemap.xml", "/llms.txt", "/api/public/tools/x", "/sign-in", "/reset-password", "/api/auth/get-session"]) {
      const res = await get(`https://getseopen.com${path}`);
      expect(getRedirectUrl(res)).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it("still guards app pages and API routes", async () => {
    expect(getRedirectUrl(await get("https://getseopen.com/rank?x=1"))).toBe("https://getseopen.com/sign-in?next=%2Frank%3Fx%3D1");
    expect((await get("https://getseopen.com/api/google/connect")).status).toBe(401);
  });

  it("lets MCP clients reach the endpoint and its OAuth discovery documents without a session", async () => {
    for (const path of ["/api/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/api/mcp", "/.well-known/oauth-authorization-server"]) {
      const res = await get(`https://getseopen.com${path}`);
      expect(getRedirectUrl(res)).toBeNull();
      expect(res.status).toBe(200);
    }
  });

  it("lets the recap's unsubscribe link through without a session, and nothing else under /api/email", async () => {
    const res = await get("https://getseopen.com/api/email/unsubscribe?t=abc.def");
    expect(getRedirectUrl(res)).toBeNull();
    expect(res.status).toBe(200);
    expect((await get("https://getseopen.com/api/email/other")).status).toBe(401);
  });

  it("lets Vercel's cron reach the worker watch without a session, and nothing else under /api/cron", async () => {
    const res = await get("https://getseopen.com/api/cron/worker-watch");
    expect(getRedirectUrl(res)).toBeNull();
    expect(res.status).toBe(200);
    expect((await get("https://getseopen.com/api/cron/other")).status).toBe(401);
  });

  it("sends a signed-out consent page to sign-in with its signed OAuth request as it is", async () => {
    const res = await get("https://getseopen.com/connect?client_id=abc&scope=read&sig=xyz");
    expect(getRedirectUrl(res)).toBe("https://getseopen.com/sign-in?client_id=abc&scope=read&sig=xyz");
    signedIn();
    expect((await get("https://getseopen.com/connect?client_id=abc&sig=xyz", "account")).status).toBe(200);
  });

  it("links stay relative", () => {
    expect(siteHref("/")).toBe("/landing");
    expect(siteHref("/privacy")).toBe("/privacy");
    expect(appHref("/sign-in")).toBe("/sign-in");
  });
});

describe("accounts", () => {
  it("lets a valid Better Auth session in and passes on refreshed cookies", async () => {
    signedIn("__Secure-better-auth.session_data=fresh; Path=/; HttpOnly; Secure");
    const res = await get("https://getseopen.com/rank", "account");
    expect(res.status).toBe(200);
    expect(getRedirectUrl(res)).toBeNull();
    expect(res.headers.get("set-cookie")).toContain("session_data=fresh");
  });

  it("remembers an opened project in the store too, which Next lets replace the response's cookies when the session cache refreshes", async () => {
    signedIn("__Secure-better-auth.session_data=fresh; Path=/; HttpOnly; Secure");
    storeCookie.mockClear();
    const res = await get("https://getseopen.com/projects/3", "account");
    expect(res.headers.get("set-cookie")).toContain("seopen_project=3");
    expect(storeCookie).toHaveBeenCalledWith("seopen_project", "3", expect.objectContaining({ httpOnly: true, path: "/" }));
    expect(isLiveProject).toHaveBeenCalledWith("u1", 3);
  });

  it("keeps the current project on a link to one that's dead, archived or another workspace's", async () => {
    signedIn();
    storeCookie.mockClear();
    isLiveProject.mockResolvedValue(false);
    for (const path of ["/projects/20", "/projects/20/settings"]) {
      const res = await get(`https://getseopen.com${path}`, "account", "3");
      // The page still renders, and gives its own 404.
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie") ?? "").not.toContain("seopen_project");
      expect(res.headers.get("x-middleware-request-cookie") ?? "").not.toContain("seopen_project=20");
    }
    expect(storeCookie).not.toHaveBeenCalled();
  });

  it("looks a project up only when the URL names a different one from the cookie", async () => {
    signedIn();
    await get("https://getseopen.com/projects/3/settings", "account", "3");
    await get("https://getseopen.com/rank", "account", "3");
    await get("https://getseopen.com/projects/new", "account", "3");
    expect(isLiveProject).not.toHaveBeenCalled();
  });

  it("sends a stale or forged session cookie to sign-in", async () => {
    expect(getRedirectUrl(await get("https://getseopen.com/rank", "account"))).toBe("https://getseopen.com/sign-in?next=%2Frank");
    expect((await get("https://getseopen.com/api/google/connect", "account")).status).toBe(401);
  });

  it("skips the session lookup when there is no session cookie", async () => {
    await get("https://getseopen.com/rank");
    expect(getSession).not.toHaveBeenCalled();
  });

  it("relays analytics without a session or a session lookup", async () => {
    const res = await get("https://getseopen.com/ingest/e/?ip=0", "account");
    expect(getRedirectUrl(res)).toBeNull();
    expect(res.status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
  });

  it("relays analytics with only the headers PostHog needs", async () => {
    const request = new NextRequest("https://getseopen.com/ingest/e/", {
      method: "POST",
      headers: {
        "x-forwarded-for": "203.0.113.7",
        "user-agent": "test",
        "content-type": "text/plain",
        "content-encoding": "gzip",
        authorization: "Bearer app-token",
        // A header a load balancer or CDN in front of the app added for the app alone.
        "x-edge-to-app-proof": "shared-secret",
      },
      body: "{}",
    });
    request.cookies.set(BETTER_AUTH_COOKIE, "token.signature");
    request.cookies.set("seopen_project", "3");
    const res = await proxy(request);
    // Next replaces the request's headers with the override list; anything left off it is removed.
    const forwarded = res.headers.get("x-middleware-override-headers")?.split(",") ?? [];
    expect(forwarded).toEqual(expect.arrayContaining(["x-forwarded-for", "user-agent", "content-type", "content-encoding"]));
    for (const dropped of ["cookie", "authorization", "x-edge-to-app-proof"]) {
      expect(forwarded, dropped).not.toContain(dropped);
      expect(res.headers.get(`x-middleware-request-${dropped}`), dropped).toBeNull();
    }
    expect(res.headers.get("x-middleware-request-x-forwarded-for")).toBe("203.0.113.7");
  });
});

describe("split hosts (the app host; next.config.ts handles the site host)", () => {
  beforeEach(() => {
    vi.stubEnv("SEOPEN_SITE_HOST", "getseopen.com");
    vi.stubEnv("SEOPEN_APP_HOST", "app.getseopen.com");
  });

  it("leaves the site host alone if the matcher ever lets it through", async () => {
    for (const path of ["/", "/pricing", "/blog/anything", "/rank"]) {
      const res = await get(`https://getseopen.com${path}`);
      expect(getRedirectUrl(res)).toBeNull();
      expect(isRewrite(res)).toBe(false);
    }
  });

  it("sends anything that isn't the app back to the site host", async () => {
    expect(getRedirectUrl(await get("https://app.getseopen.com/privacy"))).toBe("https://getseopen.com/privacy");
    expect(getRedirectUrl(await get("https://app.getseopen.com/landing"))).toBe("https://getseopen.com/");
    expect(getRedirectUrl(await get("https://app.getseopen.com/guides/x?y=1"))).toBe("https://getseopen.com/guides/x?y=1");
    expect(getRedirectUrl(await get("https://app.getseopen.com/sitemap.xml"))).toBe("https://getseopen.com/sitemap.xml");
    expect(getRedirectUrl(await get("https://app.getseopen.com/api/public/tools/x"))).toBe("https://getseopen.com/api/public/tools/x");
  });

  it("lets crawlers fetch app pages so they see the noindex header", async () => {
    const robots = await get("https://app.getseopen.com/robots.txt");
    expect(await robots.text()).toBe("User-Agent: *\nDisallow: /api/\n");
  });

  it("keeps the app and auth pages on the app host", async () => {
    expect(getRedirectUrl(await get("https://app.getseopen.com/"))).toBe("https://app.getseopen.com/sign-in");
    expect(getRedirectUrl(await get("https://app.getseopen.com/billing"))).toBe("https://app.getseopen.com/sign-in?next=%2Fbilling");
    expect((await get("https://app.getseopen.com/sign-in")).status).toBe(200);
    signedIn();
    expect((await get("https://app.getseopen.com/", "account")).status).toBe(200);
  });

  it("keeps the analytics relay on the app host", async () => {
    const res = await get("https://app.getseopen.com/ingest/flags/?v=2");
    expect(getRedirectUrl(res)).toBeNull();
    expect(res.status).toBe(200);
  });

  it("trims the relay's headers on the site host too, the one path of it that runs here", async () => {
    const request = new NextRequest("https://getseopen.com/ingest/e/", { headers: { "user-agent": "test", "x-edge-to-app-proof": "shared-secret" } });
    const forwarded = (await proxy(request)).headers.get("x-middleware-override-headers")?.split(",") ?? [];
    expect(forwarded).toContain("user-agent");
    expect(forwarded).not.toContain("x-edge-to-app-proof");
    expect(unstable_doesMiddlewareMatch({ config, url: "https://getseopen.com/ingest/e/" })).toBe(true);
    expect(unstable_doesMiddlewareMatch({ config, url: "https://getseopen.com/pricing" })).toBe(false);
  });

  it("treats other hosts (previews) as one host", async () => {
    expect(getRedirectUrl(await get("https://preview.seopen.example/"))).toBe("https://preview.seopen.example/sign-in");
    expect((await get("https://preview.seopen.example/terms")).status).toBe(200);
  });

  it("links become absolute", () => {
    expect(siteHref("/")).toBe("https://getseopen.com/");
    expect(siteHref("/landing")).toBe("https://getseopen.com/");
    expect(appHref("/sign-in")).toBe("https://app.getseopen.com/sign-in");
  });
});

describe("the visitor's address for Better Auth's rate limits", () => {
  // Next hands request-header overrides on as x-middleware-request-* response headers.
  const passed = (res: Response) => res.headers.get("x-middleware-request-x-seopen-client-ip");

  it("passes CloudFront's address, without its port, on to /api/auth", async () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SEOPEN_TRUST_PROXY", "cloudfront");
    const request = new NextRequest("https://app.getseopen.com/api/auth/sign-in/email", {
      method: "POST",
      headers: { "cloudfront-viewer-address": "198.51.100.10:46532", "x-seopen-client-ip": "192.0.2.1" },
    });
    expect(passed(await proxy(request))).toBe("198.51.100.10");
  });

  it("drops a forged address when there's no trusted one", async () => {
    vi.stubEnv("VERCEL", "");
    const request = new NextRequest("https://app.getseopen.com/api/auth/sign-in/email", { method: "POST", headers: { "x-seopen-client-ip": "192.0.2.1" } });
    const res = await proxy(request);
    expect(res.headers.get("x-middleware-override-headers")).not.toContain("x-seopen-client-ip");
    expect(passed(res)).toBeNull();
  });
});

describe("no-login mode (src/lib/auth/no-login.ts)", () => {
  /** A request from a browser on this machine, with the headers Next adds. */
  function fromHere(url: string, from = "127.0.0.1") {
    const u = new URL(url);
    return proxy(new NextRequest(url, { headers: { host: u.host, "x-forwarded-for": from } }));
  }

  beforeEach(() => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("SEOPEN_NO_LOGIN", "1");
  });

  it("signs a signed-out page request in instead of asking for a password, and keeps where it was going", async () => {
    expect(getRedirectUrl(await fromHere("http://127.0.0.1:4100/rank?x=1"))).toBe("http://127.0.0.1:4100/api/auth/local-sign-in?next=%2Frank%3Fx%3D1");
    expect(getRedirectUrl(await fromHere("http://127.0.0.1:4100/"))).toBe("http://127.0.0.1:4100/api/auth/local-sign-in");
    expect(getRedirectUrl(await fromHere("http://127.0.0.1:4100/sign-in?next=%2Faudit"))).toBe("http://127.0.0.1:4100/api/auth/local-sign-in?next=%2Faudit");
  });

  it("still answers a signed-out API call with 401", async () => {
    expect((await fromHere("http://127.0.0.1:4100/api/projects")).status).toBe(401);
  });

  it("asks for a password as before when the flag is off or the visitor isn't on this machine", async () => {
    expect(getRedirectUrl(await fromHere("http://127.0.0.1:4100/rank", "203.0.113.9"))).toBe("http://localhost:4100/sign-in?next=%2Frank");
    expect(getRedirectUrl(await fromHere("http://127.0.0.1:4100/sign-in", "203.0.113.9"))).toBeNull();
    vi.stubEnv("SEOPEN_NO_LOGIN", "");
    expect(getRedirectUrl(await fromHere("http://127.0.0.1:4100/rank"))).toBe("http://localhost:4100/sign-in?next=%2Frank");
  });
});
