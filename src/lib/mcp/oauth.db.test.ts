import { randomUUID } from "node:crypto";
import { auth as sdkAuth, Client, StreamableHTTPClientTransport, type OAuthClientProvider, type OAuthDiscoveryState, type OAuthTokens, type StoredOAuthClientInformation, type StoredOAuthTokens } from "@modelcontextprotocol/client";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * OAuth for the MCP endpoint end to end against seopen_test (src/lib/auth/oauth.ts and
 * ./oauth.ts). The MCP SDK's own client does discovery, registration, PKCE and the token swap
 * against the real Better Auth handler, in process; the browser's part (the authorize redirect, the
 * consent page's answer) is played with a real session cookie. Then: a token for workspace A can't
 * see workspace B, it gets only the tools its consent allows, refresh works, and disconnecting,
 * leaving the workspace or suspending it stops the token at the next call. API keys still work.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));
// Signing in sends nothing here, whatever sign-up the copy has.
vi.mock("@/public-signup/server", async (original) => {
  const m = await original<typeof import("@/public-signup/server")>();
  return { ...m, signup: { ...m.signup, onSession: async () => undefined } };
});
// The metadata route waits for a request with `connection()`, which needs Next's request scope.
vi.mock("next/server", async (original) => ({ ...(await original<typeof import("next/server")>()), connection: async () => {} }));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const keys = await import("./keys");
const oauth = await import("./oauth");
const { auth } = await import("@/lib/auth");
const { POST, GET } = await import("@/app/api/mcp/route");
const prm = await import("@/app/.well-known/oauth-protected-resource/api/mcp/route");
const asMetadata = await import("@/app/.well-known/oauth-authorization-server/route");

const ORIGIN = "http://127.0.0.1:4100";
const MCP_URL = `${ORIGIN}/api/mcp`;
const CALLBACK = "http://127.0.0.1:33418/callback";
const PASSWORD = `pw-${randomUUID()}`;

/** The app, served in process: what a client reaches at ORIGIN. */
async function appFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const req = input instanceof Request ? input : new Request(input, init);
  const { pathname } = new URL(req.url);
  if (pathname === "/api/mcp") return req.method === "POST" ? POST(req) : GET();
  if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/api/mcp") return prm.GET();
  if (pathname === "/.well-known/oauth-authorization-server") return asMetadata.GET(req);
  if (pathname.startsWith("/api/auth/")) return auth.handler(req);
  return new Response("Not found", { status: 404 });
}

async function seedWorkspace(tag: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: `${tag}-${randomUUID()}@example.com`, name: "", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
  const [ws] = await db.insert(s.workspaces).values({ name: `${tag}-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id });
  await db.insert(s.workspaceSettings).values({ workspaceId: ws.id, monthlyCapUsd: 10 });
  const [project] = await db.insert(s.projects).values({ workspaceId: ws.id, name: `${tag} site`, domain: `${tag}-${ws.id}.example` }).returning();
  const signIn = await auth.api.signInEmail({ body: { email: user.email, password: PASSWORD }, asResponse: true });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie).toMatch(/session_token=/);
  return { user, ws, project, cookie };
}

type Seeded = Awaited<ReturnType<typeof seedWorkspace>>;

/** An MCP client's OAuth state, kept in memory as a desktop app would keep it on disk. */
class MemoryProvider implements OAuthClientProvider {
  info?: StoredOAuthClientInformation;
  saved?: StoredOAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  constructor(private callback = CALLBACK) {}
  get redirectUrl() {
    return this.callback;
  }
  get clientMetadata() {
    return {
      client_name: "Test agent",
      redirect_uris: [this.callback],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: StoredOAuthClientInformation) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: StoredOAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(v: string) {
    this.verifier = v;
  }
  codeVerifier() {
    return this.verifier;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }
  discoveryState() {
    return this.discovery;
  }
  private discovery?: OAuthDiscoveryState;
}

/** The browser's part: open the authorize URL signed in, land on /connect, and answer it. */
async function browserConsents(url: URL, as: Seeded, answer: { accept: boolean; scope?: string }) {
  const res = await auth.handler(new Request(url, { headers: { cookie: as.cookie } }));
  expect(res.status).toBe(302);
  const consentPage = new URL(res.headers.get("location")!, ORIGIN);
  expect(consentPage.pathname).toBe("/connect");
  const posted = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie: as.cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ...answer, oauth_query: consentPage.search.slice(1) }),
    }),
  );
  expect(posted.status).toBe(200);
  const back = new URL(((await posted.json()) as { url: string }).url);
  return { consentPage, back };
}

/** A full connection as a spec-following client makes it: discovery, registration, PKCE, consent, tokens. */
async function connectApp(as: Seeded, grant: string[], provider = new MemoryProvider()) {
  expect(await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch })).toBe("REDIRECT");
  const { back } = await browserConsents(provider.authorizationUrl!, as, { accept: true, scope: grant.join(" ") });
  const code = back.searchParams.get("code");
  expect(code).toBeTruthy();
  expect(await sdkAuth(provider, { serverUrl: MCP_URL, authorizationCode: code!, iss: back.searchParams.get("iss") ?? undefined, fetchFn: appFetch })).toBe("AUTHORIZED");
  return provider;
}

const clients: Client[] = [];

async function mcpClient(provider: OAuthClientProvider) {
  const client = new Client({ name: "seopen-oauth-test", version: "1.0.0" }, { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: appFetch, authProvider: provider }));
  clients.push(client);
  return client;
}

type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolOut;

const LIST = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const rpc = (token: string) =>
  POST(
    new Request(MCP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify(LIST),
    }),
  );

describe.skipIf(!ready)("OAuth for the MCP endpoint", () => {
  let A: Seeded;
  let B: Seeded;
  let appA: MemoryProvider;

  beforeAll(async () => {
    A = await seedWorkspace("oauth-a");
    B = await seedWorkspace("oauth-b");
    appA = await connectApp(A, ["read", "offline_access"]);
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
  });

  describe("discovery", () => {
    it("answers a request with no token with a 401 naming the protected resource metadata", async () => {
      const res = await POST(new Request(MCP_URL, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(LIST) }));
      expect(res.status).toBe(401);
      const challenge = res.headers.get("www-authenticate") ?? "";
      expect(challenge).toMatch(/^Bearer /);
      expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api/mcp"`);
      // No scope in the challenge, so a client asks for every scope and the person narrows it on /connect.
      expect(challenge).not.toMatch(/scope=/);
    });

    it("serves resource metadata for the endpoint, without DPoP, and authorization server metadata at the root", async () => {
      const resource = await (await appFetch(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)).json();
      expect(resource).toMatchObject({ resource: MCP_URL, authorization_servers: [ORIGIN] });
      // With offline_access: ChatGPT asks for these scopes alone, and without it gets no refresh token.
      expect(resource.scopes_supported).toEqual(["read", "write", "research", "offline_access"]);
      expect(resource).not.toHaveProperty("dpop_signing_alg_values_supported");
      const server = await (await appFetch(`${ORIGIN}/.well-known/oauth-authorization-server`)).json();
      expect(server).toMatchObject({
        issuer: ORIGIN,
        authorization_endpoint: `${ORIGIN}/api/auth/oauth2/authorize`,
        token_endpoint: `${ORIGIN}/api/auth/oauth2/token`,
        registration_endpoint: `${ORIGIN}/api/auth/oauth2/register`,
        code_challenge_methods_supported: ["S256"],
      });
      expect(server.scopes_supported).toEqual(expect.arrayContaining(["read", "write", "research", "offline_access"]));
    });
  });

  describe("connecting", () => {
    it("asks for every scope, and the consent page reads the signed request with the app's name and where it goes back", async () => {
      const provider = new MemoryProvider();
      await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch });
      const url = provider.authorizationUrl!;
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("resource")).toBe(MCP_URL);
      expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual(["offline_access", "read", "research", "write"]);

      const res = await auth.handler(new Request(url, { headers: { cookie: A.cookie } }));
      const page = new URL(res.headers.get("location")!, ORIGIN);
      expect(await oauth.readConsentRequest(page.searchParams)).toEqual({
        clientId: provider.info!.client_id,
        name: "Test agent",
        redirectHost: "127.0.0.1:33418",
        metadataHost: null,
        scopes: ["read", "write", "research", "offline_access"],
      });
      // A changed or unsigned address isn't a request.
      const tampered = new URLSearchParams(page.searchParams);
      tampered.set("redirect_uri", "https://evil.example/cb");
      expect(await oauth.readConsentRequest(tampered)).toBeNull();
      expect(await oauth.readConsentRequest(new URLSearchParams({ client_id: provider.info!.client_id }))).toBeNull();
    });

    it("reads a request that comes back on another loopback port, as native apps do, but not another host or path", async () => {
      const provider = new MemoryProvider();
      await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch });
      const url = new URL(provider.authorizationUrl!);
      url.searchParams.set("redirect_uri", "http://127.0.0.1:51123/callback");
      const res = await auth.handler(new Request(url, { headers: { cookie: A.cookie } }));
      const page = new URL(res.headers.get("location")!, ORIGIN);
      expect(page.pathname).toBe("/connect");
      expect((await oauth.readConsentRequest(page.searchParams))?.redirectHost).toBe("127.0.0.1:51123");

      expect(oauth.sameRedirect(CALLBACK, "http://127.0.0.1/callback")).toBe(true);
      expect(oauth.sameRedirect(CALLBACK, "http://127.0.0.1:51123/other")).toBe(false);
      expect(oauth.sameRedirect(CALLBACK, "http://localhost:51123/callback")).toBe(false);
      expect(oauth.sameRedirect(CALLBACK, "http://evil.example:33418/callback")).toBe(false);
      expect(oauth.sameRedirect("https://app.example/cb", "https://app.example:8443/cb")).toBe(false);
    });

    it("sends a signed-out visitor to sign-in with the request signed, and signing in carries on to /connect", async () => {
      const provider = new MemoryProvider();
      await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch });
      const res = await auth.handler(new Request(provider.authorizationUrl!));
      const signInPage = new URL(res.headers.get("location")!, ORIGIN);
      expect(signInPage.pathname).toBe("/sign-in");
      expect(signInPage.searchParams.get("sig")).toBeTruthy();
      const signIn = await auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ email: A.user.email, password: PASSWORD, oauth_query: signInPage.search.slice(1) }),
        }),
      );
      expect(signIn.status).toBe(200);
      const body = (await signIn.json()) as { redirect?: boolean; url?: string };
      expect(body.redirect).toBe(true);
      expect(new URL(body.url!, ORIGIN).pathname).toBe("/connect");
    });

    it("issues a short-lived token for the MCP endpoint alone, carrying the workspace", async () => {
      const token = appA.saved!.access_token;
      const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
      expect(claims).toMatchObject({ iss: ORIGIN, aud: MCP_URL, sub: A.user.id, workspace_id: A.ws.id, scope: "read offline_access" });
      expect(claims.exp - claims.iat).toBe(15 * 60);
      expect(appA.saved!.refresh_token).toBeTruthy();
    });

    it("gives a refresh token to an app that asks for exactly the listed scopes, and to one connected before without", async () => {
      const D = await seedWorkspace("oauth-listed");
      const provider = new MemoryProvider();
      const connect = async (scope: string) => {
        provider.saved = undefined;
        expect(await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch })).toBe("REDIRECT");
        provider.authorizationUrl!.searchParams.set("scope", scope);
        const { consentPage, back } = await browserConsents(provider.authorizationUrl!, D, { accept: true, scope });
        expect(await sdkAuth(provider, { serverUrl: MCP_URL, authorizationCode: back.searchParams.get("code")!, iss: back.searchParams.get("iss") ?? undefined, fetchFn: appFetch })).toBe("AUTHORIZED");
        return consentPage;
      };

      await connect("read write research");
      expect(provider.saved!.refresh_token).toBeUndefined();

      const { scopes_supported } = await (await appFetch(`${ORIGIN}/.well-known/oauth-protected-resource/api/mcp`)).json();
      const consentPage = await connect(scopes_supported.join(" "));
      expect((await oauth.readConsentRequest(consentPage.searchParams))?.scopes).toContain("offline_access");
      expect(provider.saved!.refresh_token).toBeTruthy();

      const res = await appFetch(`${ORIGIN}/api/auth/oauth2/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: provider.saved!.refresh_token!, client_id: provider.info!.client_id, resource: MCP_URL }),
      });
      expect(res.status).toBe(200);
      expect((await rpc((await res.json()).access_token)).status).toBe(200);
    });

    it("needs PKCE", async () => {
      const url = new URL(appA.authorizationUrl!);
      url.searchParams.delete("code_challenge");
      url.searchParams.delete("code_challenge_method");
      const res = await auth.handler(new Request(url, { headers: { cookie: A.cookie } }));
      const location = res.headers.get("location") ?? "";
      expect(location).not.toContain("/connect");
      expect(location).not.toMatch(/[?&]code=/);
      expect(new URL(location).searchParams.get("error")).toBe("invalid_request");
    });

    it("refuses a redirect URI the app didn't register, without sending the browser there", async () => {
      const url = new URL(appA.authorizationUrl!);
      url.searchParams.set("redirect_uri", "https://evil.example/callback");
      const res = await auth.handler(new Request(url, { headers: { cookie: A.cookie } }));
      const location = new URL(res.headers.get("location")!);
      expect(location.origin).toBe(ORIGIN);
      expect(location.searchParams.get("error")).toBe("invalid_redirect");
    });

    it("refuses a code swapped without its verifier", async () => {
      const provider = new MemoryProvider();
      await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch });
      const { back } = await browserConsents(provider.authorizationUrl!, A, { accept: true, scope: "read" });
      const res = await auth.handler(
        new Request(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CALLBACK, client_id: provider.info!.client_id, code_verifier: "x".repeat(50) }),
        }),
      );
      expect(res.status).toBe(400);
    });

    it("takes the consent page's answer for every scope Claude.ai asks for, and only scopes the app asked for", async () => {
      const { grantedScopes } = await import("@/components/auth/connect-form");
      const all = new MemoryProvider();
      await sdkAuth(all, { serverUrl: MCP_URL, fetchFn: appFetch });
      const asked = all.authorizationUrl!.searchParams.get("scope")!.split(" ");
      const { back } = await browserConsents(all.authorizationUrl!, A, { accept: true, scope: grantedScopes(asked, () => false).join(" ") });
      expect(back.searchParams.get("code")).toBeTruthy();

      // An app that didn't ask to read: the provider refuses `read`, which the page used to send anyway.
      const writeOnly = new MemoryProvider();
      await sdkAuth(writeOnly, { serverUrl: MCP_URL, fetchFn: appFetch });
      const url = new URL(writeOnly.authorizationUrl!);
      url.searchParams.set("scope", "write");
      const res = await auth.handler(new Request(url, { headers: { cookie: A.cookie } }));
      const consentPage = new URL(res.headers.get("location")!, ORIGIN);
      expect((await oauth.readConsentRequest(consentPage.searchParams))?.scopes).toEqual(["write"]);
      const consent = (scope: string) =>
        auth.handler(
          new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
            method: "POST",
            headers: { cookie: A.cookie, origin: ORIGIN, "content-type": "application/json" },
            body: JSON.stringify({ accept: true, scope, oauth_query: consentPage.search.slice(1) }),
          }),
        );
      expect((await consent("read write")).status).toBe(400);
    });

    it("sends the app back with access_denied when the person cancels", async () => {
      const provider = new MemoryProvider();
      await sdkAuth(provider, { serverUrl: MCP_URL, fetchFn: appFetch });
      const { back } = await browserConsents(provider.authorizationUrl!, A, { accept: false });
      expect(back.searchParams.get("error")).toBe("access_denied");
      expect(back.searchParams.get("code")).toBeNull();
    });
  });

  describe("calling tools", () => {
    it("works as the workspace over the token, with the read tools only for a read consent", async () => {
      const client = await mcpClient(appA);
      const who = await call(client, "whoami");
      expect(who.structuredContent).toMatchObject({ workspace: A.ws.name, signed_in_with: "oauth", key: { name: "Test agent", can_make_changes: false } });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("list_projects");
      expect(tools.map((t) => t.name)).not.toContain("create_project");
    });

    it("gets the write tools only when the person allowed changes", async () => {
      const writer = await connectApp(A, ["read", "write"]);
      const { tools } = await (await mcpClient(writer)).listTools();
      expect(tools.map((t) => t.name)).toContain("create_project");
    });

    it("records the connection and its last use, and counts its requests", async () => {
      const [row] = await db
        .select()
        .from(s.oauthConnections)
        .where(and(eq(s.oauthConnections.workspaceId, A.ws.id), eq(s.oauthConnections.clientId, appA.info!.client_id)));
      expect(row.lastUsedAt).toBeInstanceOf(Date);
      const usage = await db.select().from(s.oauthConnectionUsage).where(eq(s.oauthConnectionUsage.connectionId, row.id));
      expect(usage.find((u) => u.bucket === "requests")?.count).toBeGreaterThan(0);
    });

    it("refreshes the access token with the refresh token, which rotates", async () => {
      const before = appA.saved!;
      const res = await auth.handler(
        new Request(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: before.refresh_token!, client_id: appA.info!.client_id, resource: MCP_URL }),
        }),
      );
      expect(res.status).toBe(200);
      const fresh = (await res.json()) as OAuthTokens;
      expect(fresh.access_token).not.toBe(before.access_token);
      expect(fresh.refresh_token).not.toBe(before.refresh_token);
      expect((await rpc(fresh.access_token)).status).toBe(200);
      appA.saveTokens(fresh);
    });

    it("refuses a forged, altered or expired token", async () => {
      const [h, p] = appA.saved!.access_token.split(".");
      const claims = JSON.parse(Buffer.from(p, "base64url").toString());
      const altered = `${h}.${Buffer.from(JSON.stringify({ ...claims, workspace_id: B.ws.id })).toString("base64url")}.${appA.saved!.access_token.split(".")[2]}`;
      expect((await rpc(altered)).status).toBe(401);
      expect((await rpc(`${h}.${p}.`)).status).toBe(401);
      expect(await oauth.verifyOAuthToken(appA.saved!.access_token, new Date())).not.toBeNull();
    });
  });

  describe("isolation", () => {
    it("a token for workspace A lists only A's projects and can't read B's by id or domain", async () => {
      const client = await mcpClient(appA);
      const listed = await call(client, "list_projects");
      expect((listed.structuredContent?.projects as { id: number }[]).map((p) => p.id)).toEqual([A.project.id]);
      for (const tool of ["get_overview", "get_rankings", "get_search_console", "get_audit_issues", "get_keyword_lists"]) {
        for (const project of [B.project.id, B.project.domain]) {
          const out = await call(client, tool, { project });
          expect(out.isError, `${tool} ${project}`).toBe(true);
          expect(out.content[0].text).toMatch(/No project/);
          expect(JSON.stringify(out)).not.toContain("oauth-b site");
        }
      }
    });

    it("a consent is A's: B's disconnect can't remove it, and B's list doesn't show it", async () => {
      const [consent] = await db.select().from(s.oauthConsents).where(and(eq(s.oauthConsents.clientId, appA.info!.client_id), eq(s.oauthConsents.userId, A.user.id)));
      expect(consent.referenceId).toBe(String(A.ws.id));
      expect(await oauth.disconnectApp({ workspaceId: B.ws.id }, consent.id)).toBe(false);
      expect((await oauth.listConnectedApps({ workspaceId: B.ws.id })).map((a) => a.id)).not.toContain(consent.id);
      expect((await oauth.listConnectedApps({ workspaceId: A.ws.id })).map((a) => a.id)).toContain(consent.id);
      expect((await rpc(appA.saved!.access_token)).status).toBe(200);
    });
  });

  describe("stopping", () => {
    it("stops a token when its user leaves the workspace or the workspace is suspended", async () => {
      const C = await seedWorkspace("oauth-c");
      const app = await connectApp(C, ["read"]);
      const token = app.saved!.access_token;
      expect((await rpc(token)).status).toBe(200);

      await db.update(s.workspaces).set({ status: "suspended" }).where(eq(s.workspaces.id, C.ws.id));
      expect((await rpc(token)).status).toBe(401);
      await db.update(s.workspaces).set({ status: "active" }).where(eq(s.workspaces.id, C.ws.id));
      expect((await rpc(token)).status).toBe(200);

      await db.delete(s.workspaceMembers).where(eq(s.workspaceMembers.workspaceId, C.ws.id));
      expect((await rpc(token)).status).toBe(401);
    });

    it("disconnecting on the MCP page stops the access token at once and the refresh token for good", async () => {
      const C = await seedWorkspace("oauth-d");
      const app = await connectApp(C, ["read", "offline_access"]);
      expect((await rpc(app.saved!.access_token)).status).toBe(200);

      const [listed] = await oauth.listConnectedApps({ workspaceId: C.ws.id });
      expect(listed).toMatchObject({ name: "Test agent", email: C.user.email, scopes: ["read", "offline_access"] });
      expect(await oauth.disconnectApp({ workspaceId: C.ws.id }, listed.id)).toBe(true);

      const res = await rpc(app.saved!.access_token);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("invalid_token");
      const refresh = await auth.handler(
        new Request(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.saved!.refresh_token!, client_id: app.info!.client_id }),
        }),
      );
      expect(refresh.status).toBe(400);
      expect(await oauth.listConnectedApps({ workspaceId: C.ws.id })).toEqual([]);
      expect(await db.select().from(s.oauthConnections).where(eq(s.oauthConnections.workspaceId, C.ws.id))).toEqual([]);
    });
    it("a password reset revokes the user's API keys and disconnects their apps, and no one else's", async () => {
      const D = await seedWorkspace("oauth-reset");
      const app = await connectApp(D, ["read", "write", "offline_access"]);
      const { key } = await keys.createApiKey({ workspaceId: D.ws.id, userId: D.user.id }, { name: "taken over", write: true, research: true });
      const { key: othersKey } = await keys.createApiKey({ workspaceId: B.ws.id, userId: B.user.id }, { name: "someone else's" });
      expect(await keys.verifyApiKey(key)).not.toBeNull();
      expect((await rpc(app.saved!.access_token)).status).toBe(200);

      // The link's token, as sendResetPassword would mail it.
      const token = randomUUID();
      const ctx = await auth.$context;
      await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${token}`, value: D.user.id, expiresAt: new Date(Date.now() + 3600_000) });
      // An older link, as from a second "forgot password" or an invite, that the reset must also end.
      const older = randomUUID();
      await ctx.internalAdapter.createVerificationValue({ identifier: `reset-password:${older}`, value: D.user.id, expiresAt: new Date(Date.now() + 3600_000) });
      await auth.api.resetPassword({ body: { newPassword: `new-${randomUUID()}`, token } });

      expect(await db.$count(s.verifications, eq(s.verifications.value, D.user.id))).toBe(0);
      expect(await db.$count(s.sessions, eq(s.sessions.userId, D.user.id))).toBe(0);
      expect(await keys.verifyApiKey(key)).toBeNull();
      expect((await rpc(app.saved!.access_token)).status).toBe(401);
      const refresh = await auth.handler(
        new Request(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.saved!.refresh_token!, client_id: app.info!.client_id }),
        }),
      );
      expect(refresh.status).toBe(400);
      expect(await oauth.listConnectedApps({ workspaceId: D.ws.id })).toEqual([]);
      expect(await keys.verifyApiKey(othersKey)).not.toBeNull();
      expect((await rpc(appA.saved!.access_token)).status).toBe(200);
    });

    it("a password change revokes keys and apps, only when it goes through", async () => {
      const E = await seedWorkspace("oauth-change");
      const headers = new Headers({ cookie: E.cookie });
      const app = await connectApp(E, ["read", "offline_access"]);
      const { key } = await keys.createApiKey({ workspaceId: E.ws.id, userId: E.user.id }, { name: "taken over" });
      // A wrong current password changes nothing.
      await expect(auth.api.changePassword({ body: { currentPassword: "wrong-password", newPassword: `x-${randomUUID()}`, revokeOtherSessions: true }, headers })).rejects.toThrow();
      expect(await keys.verifyApiKey(key)).not.toBeNull();
      expect((await rpc(app.saved!.access_token)).status).toBe(200);
      // A change that asks to keep other sessions signs them out and cuts agents off all the same.
      await auth.api.changePassword({ body: { currentPassword: PASSWORD, newPassword: `n-${randomUUID()}`, revokeOtherSessions: false }, headers });
      expect(await keys.verifyApiKey(key)).toBeNull();
      expect((await rpc(app.saved!.access_token)).status).toBe(401);
      expect(await oauth.listConnectedApps({ workspaceId: E.ws.id })).toEqual([]);
    });

    it("signing out everywhere else leaves an app a signed-out browser connected, unless asked to cut agents off", async () => {
      const F = await seedWorkspace("oauth-elsewhere");
      const app = await connectApp(F, ["read", "offline_access"]);
      const refresh = () =>
        auth.handler(
          new Request(`${ORIGIN}/api/auth/oauth2/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: app.saved!.refresh_token!, client_id: app.info!.client_id }),
          }),
        );
      // Another browser signs out the one the app was connected from.
      const signOutElsewhere = async (agents: boolean) => {
        const signIn = await auth.api.signInEmail({ body: { email: F.user.email, password: PASSWORD }, asResponse: true });
        const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
        const res = await auth.handler(new Request(`${ORIGIN}/api/auth/sign-out-elsewhere`, { method: "POST", headers: { cookie, origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ agents }) }));
        expect(res.status).toBe(200);
      };

      await signOutElsewhere(false);
      expect(await auth.api.getSession({ headers: new Headers({ cookie: F.cookie }) })).toBeNull();
      expect((await rpc(app.saved!.access_token)).status).toBe(200);
      const refreshed = await refresh();
      expect(refreshed.status).toBe(200);
      app.saved = (await refreshed.json()) as StoredOAuthTokens;
      expect((await rpc(app.saved.access_token)).status).toBe(200);

      await signOutElsewhere(true);
      expect((await rpc(app.saved.access_token)).status).toBe(401);
      expect((await refresh()).status).toBe(400);
    });

    it("a token from before a Disconnect stays refused after the same app connects again", async () => {
      const C = await seedWorkspace("oauth-r");
      const first = await connectApp(C, ["read"]);
      const [listed] = await oauth.listConnectedApps({ workspaceId: C.ws.id });
      expect(await oauth.disconnectApp({ workspaceId: C.ws.id }, listed.id)).toBe(true);
      // A consent is dated to the second, so the new one has to be a later second than the old token.
      await new Promise((r) => setTimeout(r, 1100));
      const again = new MemoryProvider();
      again.info = first.info;
      await connectApp(C, ["read"], again);
      expect((await rpc(again.saved!.access_token)).status).toBe(200);
      expect((await rpc(first.saved!.access_token)).status).toBe(401);
    });

    it("a code from before a Disconnect can't be swapped for tokens, even after the same app connects again", async () => {
      const C = await seedWorkspace("oauth-code");
      const first = new MemoryProvider();
      await sdkAuth(first, { serverUrl: MCP_URL, fetchFn: appFetch });
      const { back } = await browserConsents(first.authorizationUrl!, C, { accept: true, scope: "read" });
      const staleCode = back.searchParams.get("code")!;
      expect(staleCode).toBeTruthy();
      // Another app's code, and this app's code for someone else, outlive the Disconnect.
      const other = new MemoryProvider();
      await sdkAuth(other, { serverUrl: MCP_URL, fetchFn: appFetch });
      const otherCode = (await browserConsents(other.authorizationUrl!, C, { accept: true, scope: "read" })).back.searchParams.get("code")!;
      const D = await seedWorkspace("oauth-code-d");
      const sameApp = new MemoryProvider();
      sameApp.info = first.info;
      await sdkAuth(sameApp, { serverUrl: MCP_URL, fetchFn: appFetch });
      const theirCode = (await browserConsents(sameApp.authorizationUrl!, D, { accept: true, scope: "read" })).back.searchParams.get("code")!;

      // A value that isn't JSON, as other verifications may hold, doesn't trip the Disconnect.
      const plain = { id: randomUUID(), identifier: `plain-${randomUUID()}`, value: `not json "type":"authorization_code" ${first.info!.client_id}`, expiresAt: new Date(Date.now() + 60_000) };
      await db.insert(s.verifications).values(plain);

      const [listed] = (await oauth.listConnectedApps({ workspaceId: C.ws.id })).filter((a) => a.clientId === first.info!.client_id);
      expect(await oauth.disconnectApp({ workspaceId: C.ws.id }, listed.id)).toBe(true);
      expect(await db.select({ id: s.verifications.id }).from(s.verifications).where(eq(s.verifications.id, plain.id))).toEqual([{ id: plain.id }]);
      await db.delete(s.verifications).where(eq(s.verifications.id, plain.id));
      await new Promise((r) => setTimeout(r, 1100));
      const again = new MemoryProvider();
      again.info = first.info;
      await connectApp(C, ["read"], again);

      const swap = (code: string, provider: MemoryProvider) =>
        auth.handler(
          new Request(`${ORIGIN}/api/auth/oauth2/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: provider.info!.client_id, code_verifier: provider.verifier, resource: MCP_URL }),
          }),
        );
      expect((await swap(staleCode, first)).status).toBe(400);
      expect((await swap(otherCode, other)).status).toBe(200);
      expect((await swap(theirCode, sameApp)).status).toBe(200);
      expect((await rpc(again.saved!.access_token)).status).toBe(200);
    });
  });

  it("leaves API keys working as before", async () => {
    const { key } = await keys.createApiKey({ workspaceId: A.ws.id, userId: A.user.id }, { name: "still works" });
    const client = new Client({ name: "seopen-key-test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: appFetch, authProvider: { token: async () => key } }));
    clients.push(client);
    expect((await call(client, "whoami")).structuredContent).toMatchObject({ workspace: A.ws.name, signed_in_with: "api_key" });
  });
});
