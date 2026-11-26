import {
  createMcpHandler,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import { authBaseUrl } from "@/lib/auth";
import { oauthIssuer } from "@/lib/auth/oauth";
import { appOrigin } from "@/lib/hosts";
import { looksLikeKey, verifyApiKey, type Principal } from "./keys";
import { consumeLimit } from "./limits";
import { verifyOAuthToken } from "./oauth";
import { buildServer } from "./server";

/**
 * `POST /api/mcp`: Streamable HTTP, stateless, JSON responses. Serves both the 2026-07-28 protocol and 2025-era clients. Requests carry a bearer
 * token: a workspace API key, or an access token from OAuth (./oauth.ts). Cookies are never read, so
 * a web page can't borrow a visitor's session. A request without a good token gets a 401 naming the
 * protected resource metadata, which is how an OAuth client finds where to sign in.
 *
 * Nothing here holds a stream open. The SDK serves `subscriptions/listen` as an endless SSE stream
 * whatever `responseMode` says, which on a serverless host runs until the function times out.
 */

/** A verified key is good for this request; `expiresAt` must be set or the SDK refuses the token. */
const AUTH_TTL_S = 300;

async function verifyAccessToken(token: string): Promise<AuthInfo> {
  const key = looksLikeKey(token);
  const principal = key ? await verifyApiKey(token) : await verifyOAuthToken(token);
  if (!principal) {
    throw new OAuthError(OAuthErrorCode.InvalidToken, key ? "Unknown, revoked or expired SEOpen API key." : "Unknown, expired or disconnected access token.");
  }
  // Every key and every consent includes read; this is the check `requiredScopes` would make.
  if (!principal.scopes.includes("read")) throw new OAuthError(OAuthErrorCode.InsufficientScope, "This token can't read the workspace.");
  const now = Math.floor(Date.now() / 1000);
  const expiry = principal.expiresAt ? Math.floor(principal.expiresAt.getTime() / 1000) : Infinity;
  return {
    token,
    clientId: principal.via.kind === "key" ? `key:${principal.via.keyId}` : principal.via.clientId,
    scopes: principal.scopes,
    expiresAt: Math.min(now + AUTH_TTL_S, expiry),
    extra: { principal },
  };
}

/** Where an OAuth client reads which server to sign in with (RFC 9728), named in every 401. */
export function resourceMetadataUrl(): string {
  return `${oauthIssuer(authBaseUrl())}/.well-known/oauth-protected-resource/api/mcp`;
}

/*
 * No `requiredScopes`: the SDK would put them in the 401's `scope`, and a client asks for exactly
 * what a challenge names. Without it the client asks for every scope the metadata lists, and the
 * consent page lets the person narrow that, as the key form's boxes do.
 */
let gate: ReturnType<typeof requireBearerAuth> | undefined;
function authenticate(request: Request) {
  gate ??= requireBearerAuth({ verifier: { verifyAccessToken }, resourceMetadataUrl: resourceMetadataUrl() });
  return gate(request);
}

const mcp = createMcpHandler(
  ({ authInfo }) => {
    const principal = authInfo?.extra?.principal as Principal | undefined;
    // The route authenticates every request before it reaches the handler.
    if (!principal) throw new Error("MCP request without a verified principal");
    return buildServer(principal);
  },
  // No subscriptions at all: if a listen ever got past `listenRefused`, the SDK would answer it without a stream.
  { legacy: "stateless", responseMode: "json", maxSubscriptions: 0, onerror: (e) => console.error("[mcp]", e) },
);

/** Hostnames whose pages may call the endpoint: the app itself, and local tools like the MCP Inspector. */
function allowedOrigins(): string[] {
  return [new URL(appOrigin()).hostname, "localhost", "127.0.0.1", "[::1]"];
}

export async function handleMcp(request: Request): Promise<Response> {
  const rejected = originValidationResponse(request, allowedOrigins());
  if (rejected) return rejected;
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const principal = auth.extra!.principal as Principal;
  const limit = await consumeLimit(principal, "requests");
  if (!limit.ok) return tooManyRequests(limit.retryAfterS, limit.message);
  // A 2026 request must name its method in this header, and the SDK refuses one that disagrees with its body.
  if (request.headers.get("mcp-method") === "subscriptions/listen") return listenRefused(request);
  // A 2025-era POST may carry a JSON-RPC batch, and the SDK runs every message in it. The limit counts
  // what runs, so the messages after the first are counted here before any of them starts.
  const body = await readJson(request);
  const extra = Array.isArray(body) && body.length <= MAX_BATCH ? body.length - 1 : 0;
  if (extra > 0) {
    const more = await consumeLimit(principal, "requests", new Date(), extra);
    if (!more.ok) return tooManyRequests(more.retryAfterS, more.message);
  }
  const res = await mcp.fetch(request, { authInfo: auth, ...(body !== undefined && { parsedBody: body }) });
  res.headers.set("Cache-Control", "no-store");
  return res;
}

/** The most messages the SDK takes in one batch; it refuses a longer one without running any. */
const MAX_BATCH = 100;

/** The SDK's own limit on a request body (4 MiB). A body over it is left for the SDK to refuse. */
const MAX_BODY = 4 * 1024 * 1024;

/**
 * The POST body as JSON, read from a copy so the SDK still gets the request as it came, or undefined
 * when it is missing, over MAX_BODY or not JSON. Those are left for the SDK to answer in its own words.
 */
async function readJson(request: Request): Promise<unknown> {
  if (request.method !== "POST" || !request.body) return undefined;
  const reader = request.clone().body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return undefined;
  }
}

/** Word for word how the SDK answers a method the server doesn't have, so a client treats it as any unsupported method. */
async function listenRefused(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  const id = (body as { id?: unknown } | null)?.id;
  return Response.json(
    { jsonrpc: "2.0", id: typeof id === "string" || typeof id === "number" ? id : null, error: { code: -32601, message: "Method not found" } },
    { status: 404, headers: { "Cache-Control": "no-store" } },
  );
}

/** A JSON-RPC error with HTTP 429, so clients that read either see why and when to retry. */
function tooManyRequests(retryAfterS: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status: 429, headers: { "Retry-After": String(retryAfterS), "Cache-Control": "no-store" } },
  );
}

export function methodNotAllowed(): Response {
  return new Response("Method not allowed. SEOpen's MCP endpoint takes POST only.", { status: 405, headers: { Allow: "POST" } });
}
