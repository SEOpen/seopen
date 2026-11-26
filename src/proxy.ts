import { getSessionCookie } from "better-auth/cookies";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { INGEST_PATH, INGEST_RESPONSE_HEADERS, ingestDestination } from "@/lib/analytics/config";
import { loopbackRedirect } from "@/lib/auth/base-url";
import { noLoginAllowed } from "@/lib/auth/no-login";
import { isAuthPage } from "@/lib/auth/redirect";
import { isAppPath, splitHosts } from "@/lib/hosts";
import { PROJECT_COOKIE, PROJECT_COOKIE_OPTIONS, projectIdFromPath } from "@/lib/project-cookie";
import { declaresTooLargeBody } from "@/lib/web/body-limit";
import { withClientIpHeader } from "@/lib/web/client-ip";

/**
 * The sign-in gate, plus the app host's half of the host split (src/lib/hosts.ts). The site host
 * reaches here only for the analytics relay and /api/auth: the matcher skips the rest, and next.config.ts redirects its app paths. Every
 * app page, API route and Server Action needs a Better Auth session. The proxy runs on Node, so
 * it checks the session for real, against its row, so a session ended anywhere is refused at once.
 * Better Auth is imported only when a session cookie needs checking.
 */
export async function proxy(request: NextRequest) {
  const { pathname, search, hostname } = request.nextUrl;
  const hosts = splitHosts();

  // Next would hand on only the first part of such a body (src/lib/web/body-limit.ts): refuse it whole.
  if (declaresTooLargeBody(request.headers)) return new NextResponse("Request body too large.", { status: 413 });

  // A self-hosted copy opened at localhost when it lives at 127.0.0.1 (or the reverse): sign-in trusts one origin.
  // The Host header, not nextUrl: Next rewrites 127.0.0.1 and [::1] in nextUrl to "localhost".
  const loopback = hosts ? null : loopbackRedirect(new URL(`${request.nextUrl.protocol}//${request.headers.get("host") ?? "invalid"}${pathname}${search}`));
  if (loopback) return NextResponse.redirect(loopback, 307);

  // /ingest only relays analytics to PostHog, on either host; the last events of a session can land after sign-out.
  if (pathname === INGEST_PATH || pathname.startsWith(`${INGEST_PATH}/`)) return relay(request);

  // Better Auth rate-limits by the address in CLIENT_IP_HEADER, which only this sets (src/lib/web/client-ip.ts).
  // On every host, and above the site host's way out: a request that names the site host to a copy
  // with one host would otherwise bring its own address for the limits to count by.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next({ request: { headers: withClientIpHeader(request.headers) } });

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

  // One host (local, previews): everything but the app is the public marketing site.
  if ((pathname !== "/" && !isAppPath(pathname)) || isAuthPage(pathname)) return NextResponse.next();
  // Stripe's webhook signs its own requests; checkout sends a signed-out visitor to sign-in itself.
  // The MCP endpoint takes a bearer API key or OAuth token instead of a session and checks it in the
  // route; its OAuth discovery documents are public.
  // PostHog's servers fetch the OAuth client metadata document, with no session.
  // The recap's unsubscribe link checks its own signed token, and mail apps post to it with no session.
  // Vercel's cron calls the worker watch with CRON_SECRET as a bearer token, which the route checks.
  if (pathname === "/api/webhooks/stripe" || pathname === "/api/billing/checkout" || pathname === "/api/mcp" || pathname === "/api/posthog/client-metadata" || pathname === "/api/email/unsubscribe" || pathname === "/api/cron/worker-watch") return NextResponse.next();
  if (pathname.startsWith("/.well-known/")) return NextResponse.next();

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
 * What the /ingest relay passes on to PostHog: how to read the body, who the visitor is and where they
 * are (PostHog looks up the location from x-forwarded-for), and the page that sent the event.
 */
const RELAY_HEADERS = new Set([
  "host",
  "content-type",
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "accept",
  "accept-encoding",
  "accept-language",
  "user-agent",
  "origin",
  "referer",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
  "x-real-ip",
]);

/**
 * Sends a request under /ingest on to PostHog, a service outside this one. The browser adds our
 * cookies, the HttpOnly session among them, since /ingest is on our own host, and a load balancer
 * or CDN in front of the app may add headers meant for the app alone, such as the one it proves
 * itself with. So only the headers PostHog needs go on; a header nobody listed stays here. This is
 * the only way to PostHog: next.config.ts has no rewrite for /ingest, so a path that isn't relayed
 * here (/ingest itself, another letter case, analytics off) is a 404 and nothing is sent.
 */
function relay(request: NextRequest): NextResponse {
  const destination = ingestDestination(request.nextUrl.pathname, request.nextUrl.search, request.method);
  if (!destination) return new NextResponse(null, { status: 404 });
  const headers = new Headers();
  for (const [name, value] of request.headers) if (RELAY_HEADERS.has(name)) headers.set(name, value);
  // Set on the rewrite, these reach the browser over PostHog's own answer (INGEST_RESPONSE_HEADERS).
  return NextResponse.rewrite(destination, { request: { headers }, headers: INGEST_RESPONSE_HEADERS });
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
    // The analytics relay runs here on every host: this is the only way from /ingest to PostHog.
    "/ingest/:path*",
    // So does sign-in: its rate limits count by a header only the proxy may set.
    "/api/auth/:path*",
  ],
};
