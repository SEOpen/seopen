import { createHash, randomBytes, randomUUID } from "node:crypto";
import { like } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { testDb } from "@/db/test-db";

/**
 * The limits in front of client ID metadata documents (./client-metadata.ts), against seopen_test
 * and the real Better Auth handler. Only the network is played: hosts under connector.example serve
 * a valid document, anything else fails to connect. The plugin's budget, checks and storing run as shipped.
 */

vi.mock("server-only", () => ({}));
vi.mock("@/lib/jobs/boss", () => ({ enqueue: vi.fn(async () => "job") }));
vi.mock("@/public-signup/server", async (original) => {
  const m = await original<typeof import("@/public-signup/server")>();
  return { ...m, signup: { ...m.signup, onSession: async () => undefined } };
});
const net = vi.hoisted(() => ({ fetched: [] as string[] }));
vi.mock("@better-auth/cimd/node", () => ({
  fetchClientMetadataResource: async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    net.fetched.push(url);
    if (!new URL(url).hostname.endsWith("connector.example")) throw new TypeError("connect failed");
    return new Response(
      JSON.stringify({ client_id: url, client_name: "Connector", redirect_uris: ["https://connector.example/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
}));

const ready = await testDb();

const { db } = await import("@/db");
const s = await import("@/db/schema");
const { auth } = await import("@/lib/auth");
const { UNKNOWN_CLIENT_LIMIT } = await import("./client-metadata");
const { CLIENT_IP_HEADER } = await import("@/lib/web/client-ip");

const ORIGIN = "http://127.0.0.1:4100";
const MCP_URL = `${ORIGIN}/api/mcp`;
const CALLBACK = "https://connector.example/callback";
const PASSWORD = `pw-${randomUUID()}`;
const RUN = randomUUID().slice(0, 8);

/** An address no other run counts against: 198.18.0.0/15 is set aside for tests. */
const address = () => `198.18.${randomBytes(1)[0]}.${randomBytes(1)[0]}`;
const pkce = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};
const authorizeUrl = (clientId: string, challenge = pkce().challenge) =>
  new URL(`${ORIGIN}/api/auth/oauth2/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: CALLBACK, scope: "read offline_access", state: "s", code_challenge: challenge, code_challenge_method: "S256", resource: MCP_URL })}`);

/** An authorize request from a visitor with no session, as the proxy hands it on from one address. */
async function ask(clientId: string, from: string) {
  const res = await auth.handler(new Request(authorizeUrl(clientId), { headers: { [CLIENT_IP_HEADER]: from } }));
  const location = res.headers.get("location");
  const to = location ? new URL(location, ORIGIN) : null;
  const error = to ? to.searchParams.get("error") : ((await res.json().catch(() => ({}))) as { error?: string }).error;
  return { status: res.status, page: to?.pathname ?? null, error: error ?? null };
}

const token = (params: Record<string, string>) =>
  auth.handler(new Request(`${ORIGIN}/api/auth/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...params, resource: MCP_URL }) }));

/** A connector a workspace owner has connected by its URL, and the refresh it makes later. */
async function connectedApp(tag: string) {
  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email: `${tag}-${randomUUID()}@example.com`, name: "", emailVerified: true }, { method: "admin" });
  await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: await ctx.password.hash(PASSWORD) });
  const [ws] = await db.insert(s.workspaces).values({ name: `${tag}-${randomUUID()}`, plan: "internal" }).returning();
  await db.insert(s.workspaceMembers).values({ workspaceId: ws.id, userId: user.id });
  const signIn = await auth.api.signInEmail({ body: { email: user.email, password: PASSWORD }, asResponse: true });
  const cookie = signIn.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");

  const clientId = `https://${tag}-${RUN}.connector.example/client.json`;
  const { verifier, challenge } = pkce();
  const res = await auth.handler(new Request(authorizeUrl(clientId, challenge), { headers: { cookie, [CLIENT_IP_HEADER]: address() } }));
  const consentPage = new URL(res.headers.get("location")!, ORIGIN);
  expect(consentPage.pathname).toBe("/connect");
  const posted = await auth.handler(
    new Request(`${ORIGIN}/api/auth/oauth2/consent`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ accept: true, scope: "read offline_access", oauth_query: consentPage.search.slice(1) }),
    }),
  );
  const code = new URL(((await posted.json()) as { url: string }).url).searchParams.get("code")!;
  const swap = await token({ grant_type: "authorization_code", code, redirect_uri: CALLBACK, client_id: clientId, code_verifier: verifier });
  expect(swap.status).toBe(200);
  const { refresh_token } = (await swap.json()) as { refresh_token: string };
  return { clientId, origin: new URL(clientId).origin, refresh: () => token({ grant_type: "refresh_token", refresh_token, client_id: clientId }) };
}

/** Moves the clock on (Date only): past the hour the plugin keeps a document for, and past earlier cases' counts. */
let clock = Date.now();
const later = (minutes: number) => vi.useFakeTimers({ toFake: ["Date"], now: (clock += minutes * 60_000) });

describe.skipIf(!ready)("client ID metadata documents", () => {
  afterEach(() => void vi.useRealTimers());
  afterAll(async () => {
    await db.delete(s.oauthClients).where(like(s.oauthClients.clientId, `https://%${RUN}%`));
    await db.delete(s.rateLimits).where(like(s.rateLimits.key, "seopen:new-client-url:198.18.%"));
  });

  it("refuses a URL it would never read without counting it against anyone", async () => {
    const app = await connectedApp("cimd-private");
    later(61);
    const before = net.fetched.length;
    const from = address();
    for (let i = 0; i < 150; i++) {
      const answer = await ask(`https://10.0.0.${(i % 5) + 1}/${RUN}-${i}`, from);
      expect(answer.error, String(i)).toBe("invalid_client");
    }
    expect(net.fetched.length).toBe(before);
    // The same address can still bring a real app, and the connected one reads its document again.
    expect((await ask(`https://new-private-${RUN}.connector.example/client.json`, from)).page).toBe("/sign-in");
    expect((await app.refresh()).status).toBe(200);
  }, 60_000);

  it("lets one address name only a few new URLs a minute, and leaves everyone else's reads alone", async () => {
    const app = await connectedApp("cimd-made-up");
    later(61);
    const before = net.fetched.length;
    const from = address();
    const answers: string[] = [];
    for (let i = 0; i < 150; i++) {
      const answer = await ask(`https://nobody-home-${(i % 5) + 1}.example.org/${RUN}-${i}`, from);
      answers.push(`${answer.status} ${answer.error}`);
    }
    // Past the limit nothing is fetched and nothing is taken from the shared budget.
    expect(net.fetched.length - before).toBe(UNKNOWN_CLIENT_LIMIT.max);
    expect(answers.slice(UNKNOWN_CLIENT_LIMIT.max).every((a) => a === "429 temporarily_unavailable")).toBe(true);
    expect((await ask(`https://new-made-up-${RUN}.connector.example/client.json`, from)).error).toBe("temporarily_unavailable");

    expect((await app.refresh()).status).toBe(200);
    expect((await ask(`https://new-made-up-${RUN}.connector.example/client.json`, address())).page).toBe("/sign-in");
    // A minute on, the address may bring a new app again.
    later(1);
    expect((await ask(`https://new-made-up-2-${RUN}.connector.example/client.json`, from)).page).toBe("/sign-in");
  }, 60_000);

  it("keeps a connected app working from its stored row when its document can't be read again just now", async () => {
    const app = await connectedApp("cimd-origin");
    later(61);
    // Many addresses use up the minute's reads for the app's own origin.
    let refused = 0;
    for (let i = 0; i < 40; i++) if ((await ask(`${app.origin}/made-up-${i}.json`, address())).error === "temporarily_unavailable") refused++;
    expect(refused).toBeGreaterThan(0);
    expect((await ask(`${app.origin}/one-more.json`, address())).error).toBe("temporarily_unavailable");

    const before = net.fetched.length;
    expect((await app.refresh()).status).toBe(200);
    expect(net.fetched.length).toBe(before);
  }, 60_000);
});
