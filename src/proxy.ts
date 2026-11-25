import { getSessionCookie } from "better-auth/cookies";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { loopbackRedirect } from "@/lib/auth/base-url";
import { noLoginAllowed } from "@/lib/auth/no-login";
import { isAuthPage } from "@/lib/auth/redirect";
import { isAppPath, splitHosts } from "@/lib/hosts";
import { PROJECT_COOKIE, PROJECT_COOKIE_OPTIONS, projectIdFromPath } from "@/lib/project-cookie";
import { withClientIpHeader } from "@/lib/web/client-ip";

/**
 * The sign-in gate, plus the app host's half of the host split (src/lib/hosts.ts). The site host
 * never reaches here: the matcher skips it, and next.config.ts redirects its app paths. Every
 * app page, API route and Server Action needs a Better Auth session. The proxy runs on Node, so
 * it checks the session for real, against its row, so a session ended anywhere is refused at once.
 * Better Auth is imported only when a session cookie needs checking.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search, hostname } = request.nextUrl;
  const hosts = splitHosts();

  // A self-hosted copy opened at localhost when it lives at 127.0.0.1 (or the reverse): sign-in trusts one origin.
  // The Host header, not nextUrl: Next rewrites 127.0.0.1 and [::1] in nextUrl to "localhost".
  const loopback = hosts ? null : loopbackRedirect(new URL(`${request.nextUrl.protocol}//${request.headers.get("host") ?? "invalid"}${pathname}${search}`));
  if (loopback) return NextResponse.redirect(loopback, 307);

  // Only if the matcher's host check is skipped: next.config.ts has already routed this request.
  if (hosts && hostname === hosts.site) return NextResponse.next();

  if (hosts && hostname === hosts.app) {
    if (pathname === "/robots.txt") {
      // Crawlers may fetch app pages so they see the noindex header (next.config.ts) and drop them.
      return new NextResponse("User-Agent: *\nDisallow: /api/\n", { headers: { "content-type": "text/plain" } });
    }
    if (pathname !== "/" && !isAppPath(pathname)) {
      const target = pathname === "/landing" ? "/" : pathname;
      return NextResponse.redirect(`https://${hosts.site}${target}${search}`, 308);
    }
  }

  // No-login mode (src/lib/auth/no-login.ts): sign-in has nothing to ask, so it signs the owner in.
  if (pathname === "/sign-in" && noLoginAllowed(request.headers)) return localSignIn(request, request.nextUrl.searchParams.get("next"));

  // Better Auth rate-limits by the address in CLIENT_IP_HEADER, which only this sets (src/lib/web/client-ip.ts).
  if (pathname.startsWith("/api/auth/")) return NextResponse.next({ request: { headers: withClientIpHeader(request.headers) } });
  // One host (local, previews): everything but the app is the public marketing site.
  if ((pathname !== "/" && !isAppPath(pathname)) || isAuthPage(pathname)) return NextResponse.next();
  // Stripe's webhook signs its own requests; checkout sends a signed-out visitor to sign-in itself.
  // The MCP endpoint takes a bearer API key or OAuth token instead of a session and checks it in the
  // route; its OAuth discovery documents are public.
  // /ingest only relays analytics to PostHog; the last events of a session can land after sign-out.
  // PostHog's servers fetch the OAuth client metadata document, with no session.
  // The recap's unsubscribe link checks its own signed token, and mail apps post to it with no session.
  // Vercel's cron calls the worker watch with CRON_SECRET as a bearer token, which the route checks.
  if (pathname === "/api/webhooks/stripe" || pathname === "/api/billing/checkout" || pathname === "/api/mcp" || pathname === "/api/posthog/client-metadata" || pathname === "/api/email/unsubscribe" || pathname === "/api/cron/worker-watch") return NextResponse.next();
  if (pathname.startsWith("/.well-known/")) return NextResponse.next();
  if (pathname.startsWith("/ingest/")) return withoutCookies(request);

  if (getSessionCookie(request)) {
    const { auth } = await import("@/lib/auth");
    const { headers, response } = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
    if (response) {
      // Pass on a refreshed session expiry.
      const res = await rememberProject(request, response.user.id);
      for (const cookie of headers.getSetCookie()) res.headers.append("set-cookie", cookie);
      return res;
    }
  }

  if (pathname.startsWith("/api/")) return new NextResponse("Unauthorized", { status: 401 });
  if (noLoginAllowed(request.headers)) return localSignIn(request, pathname === "/" ? null : pathname + search);
  const signIn = new URL("/sign-in", request.url);
  // The consent page's signed OAuth request goes to sign-in as it is, which picks the connection up after.
  if (pathname === "/connect") return NextResponse.redirect(new URL(`/sign-in${search}`, request.url));
  if (pathname !== "/") signIn.searchParams.set("next", pathname + search);
  return NextResponse.redirect(signIn);
}

/** No-login mode's way in: the endpoint checks the request again, makes the owner's session and goes on to `next`. */
function localSignIn(request: NextRequest, next: string | null): NextResponse {
  // The Host header, not request.url: Next writes 127.0.0.1 as "localhost" there, and the session cookie must land on the host the browser uses.
  const url = new URL("/api/auth/local-sign-in", `${request.nextUrl.protocol}//${request.headers.get("host")}`);
  if (next) url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

/**
 * The /ingest rewrite (next.config.ts) forwards the browser's request to PostHog, and the browser
 * sends our cookies with it, the HttpOnly session among them, since /ingest is on our own host.
 * PostHog needs none of them, so they're dropped. The x-forwarded-* headers stay: PostHog reads the
 * visitor's IP from them for its location lookup.
 */
function withoutCookies(request: NextRequest): NextResponse {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return NextResponse.next({ request: { headers } });
}

/**
 * Opening /projects/<id> (or its settings) makes that project the current one, so /rank, /audit
 * and the rest follow it. The cookie can't be set while the page renders, so it is set here, on
 * the request too, and the page's own render already sees it. Links to /projects/<id> turn off
 * prefetch, since a prefetch would pass through here as well.
 *
 * Only a live project of this account's workspace counts. A dead link, an archived project's settings
 * or another workspace's id would replace the cookie with an id getCurrentProject ignores, and the
 * switcher would drop to the first project. The lookup only runs when the URL names a different project
 * from the cookie, so it costs one query per switch.
 *
 * Better Auth's nextCookies plugin writes a refreshed session cookie through next/headers, and Next then
 * replaces the response's set-cookie with what that store holds. That happens about once a day per
 * session (updateAge), so the project cookie goes in the store as well or it is lost.
 */
async function rememberProject(request: NextRequest, userId: string): Promise<NextResponse> {
  const id = projectIdFromPath(request.nextUrl.pathname);
  if (!id || request.cookies.get(PROJECT_COOKIE)?.value === id) return NextResponse.next();
  const { isLiveProject } = await import("@/lib/workspace/current");
  if (!(await isLiveProject(userId, Number(id)))) return NextResponse.next();
  request.cookies.set(PROJECT_COOKIE, id);
  const res = NextResponse.next({ request: { headers: request.headers } });
  res.cookies.set(PROJECT_COOKIE, id, PROJECT_COOKIE_OPTIONS);
  (await cookies()).set(PROJECT_COOKIE, id, PROJECT_COOKIE_OPTIONS);
  return res;
}

export const config = {
  matcher: [
    {
      source: "/((?!_next/static|_next/image|favicon.ico|icon.png|icon.svg|apple-icon.png).*)",
      // The marketing host is served straight from the CDN. Matcher values must be literals.
      missing: [{ type: "host", value: "getseopen\\.com" }],
    },
  ],
};
