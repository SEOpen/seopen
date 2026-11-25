import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { asc, eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import { db } from "@/db";
import { workspaceMembers } from "@/db/schema";
import { HOSTED_DOCS_ORIGIN } from "@/lib/docs-redirects";

/**
 * OAuth 2.1 for the MCP server. The app is the authorization
 * server for its own MCP endpoint: Better Auth's oauth-provider through `@better-auth/mcp`, `jwt()`
 * to sign access tokens, and `@better-auth/cimd` for client ID metadata documents. Claude.ai, Claude
 * Desktop and ChatGPT connectors find all of it from the MCP endpoint's 401.
 *
 * - Scopes mirror an API key's boxes: `read` always, `write` for "Can make changes", `research` for
 *   "Can spend research credits", plus `offline_access` for a refresh token. The consent page
 *   (`/connect`) lets the user turn the two off, as the key form does.
 * - A consent belongs to one workspace: `consentReferenceId` is the workspace the account works in,
 *   and every token carries it as `workspace_id`. The MCP endpoint checks the consent on every call
 *   (src/lib/mcp/oauth.ts), so disconnecting on the MCP page stops an app at once.
 * - Access tokens are JWTs for the MCP endpoint alone, good for 15 minutes; refresh tokens last 30
 *   days and rotate on use. PKCE (S256) is required, and redirect URIs must match the registered ones.
 */

/** What an app can be allowed to do. The MCP endpoint maps these to tools as it does a key's scopes. */
export const MCP_SCOPES = ["read", "write", "research"] as const;
export const OAUTH_SCOPES = [...MCP_SCOPES, "offline_access"] as const;

export const ACCESS_TOKEN_TTL_S = 15 * 60;
const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;

/** The access token claim naming the workspace the consent was given for. */
export const WORKSPACE_CLAIM = "workspace_id";

/** Where the app lives, without a path: the issuer of every token. */
export function oauthIssuer(baseUrl: string): string {
  return new URL(baseUrl).origin;
}

/** The MCP endpoint, the only resource tokens are issued for, and their audience. */
export function mcpResource(baseUrl: string): string {
  return `${oauthIssuer(baseUrl)}/api/mcp`;
}

/**
 * The MCP endpoint's protected resource metadata (RFC 9728), served at the root because the endpoint
 * is `/api/mcp`, not under Better Auth's base path. It leaves out `dpop_signing_alg_values_supported`
 * (which `@better-auth/mcp`'s own copy lists) because the endpoint takes bearer tokens only; without
 * it a client knows not to bind its token with DPoP.
 *
 * It lists `offline_access`, which the MCP spec's draft says a resource should leave to the
 * authorization server's metadata. ChatGPT asks for exactly the scopes listed here, so without it
 * ChatGPT gets no refresh token and has to be connected again when the access token runs out.
 */
export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: mcpResource(baseUrl),
    authorization_servers: [oauthIssuer(baseUrl)],
    bearer_methods_supported: ["header"],
    scopes_supported: [...OAUTH_SCOPES],
    resource_name: "SEOpen",
    // Public, unlike the app's /agents page, which needs a sign-in. A copy without the docs pages
    // sends /docs to the hosted docs anyway (src/lib/docs-redirects.ts).
    resource_documentation: `${HOSTED_DOCS_ORIGIN}/docs/agents/connect`,
  };
}

/**
 * The workspace a signed-in account acts in, by the rule `currentWorkspace()` uses: the oldest
 * membership. Null for an account in none.
 */
export async function workspaceOfUser(userId: string): Promise<number | null> {
  const [row] = await db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaceMembers.createdAt), asc(workspaceMembers.workspaceId))
    .limit(1);
  return row?.id ?? null;
}

/** Better Auth endpoints the MCP server doesn't use, closed so nothing can reach them over HTTP. */
export const OAUTH_DISABLED_PATHS = [
  // Session JWTs: nothing in the app needs one, and an access token must only ever come from consent.
  "/token",
  // Client and consent management through the API; apps register themselves, and the MCP page disconnects them.
  "/oauth2/create-client",
  "/oauth2/get-client",
  "/oauth2/get-clients",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/client/rotate-keys",
  "/oauth2/public-client",
  "/oauth2/public-client-prelogin",
  "/oauth2/get-consent",
  "/oauth2/get-consents",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  // OpenID Connect, which this server doesn't offer (no `openid` scope).
  "/oauth2/userinfo",
  "/oauth2/end-session",
  "/oauth2/end-session/confirm",
];

export function oauthPlugins(baseUrl: string) {
  const issuer = oauthIssuer(baseUrl);
  const resource = mcpResource(baseUrl);
  return [
    jwt({
      // `jwk` so that, with usePlural, the table is `jwks` (src/db/schema/auth.ts).
      schema: { jwks: { modelName: "jwk" } },
      jwt: { issuer },
      // Sessions stay cookies: no `set-auth-jwt` header on every response.
      disableSettingJwtHeader: true,
    }),
    mcp({
      resource,
      loginPage: "/sign-in",
      consentPage: "/connect",
      scopes: [...OAUTH_SCOPES],
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_S,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_S,
      // Older clients (Claude Code, Cursor, Claude Desktop) still register themselves (RFC 7591), with
      // no account. Registering grants nothing: every app still needs a person's consent, and one that
      // has none 90 days after registering is deleted (purgeUnusedOAuthClients, src/lib/auth/retention.ts).
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      clientRegistrationRequirePKCE: true,
      // Native clients that leave out application_type (Cursor, older Claude Code) with a loopback callback.
      clientRegistrationDefaultApplicationType: "infer",
      // Nobody manages clients through a session; the provider's own client CRUD is closed too.
      clientPrivileges: () => false,
      postLogin: {
        page: "/connect",
        shouldRedirect: () => false,
        consentReferenceId: async ({ user }) => {
          const workspaceId = await workspaceOfUser(user.id);
          if (workspaceId == null) throw new APIError("FORBIDDEN", { error: "access_denied", error_description: "This account isn't a member of any workspace yet." });
          return String(workspaceId);
        },
      },
      customAccessTokenClaims: ({ referenceId }) => (referenceId ? { [WORKSPACE_CLAIM]: Number(referenceId) } : {}),
      advertisedMetadata: { scopes_supported: [...OAUTH_SCOPES] },
    }),
    cimd({
      // Resolves the host once, refuses private addresses, pins the connection and never follows a redirect.
      fetchClientMetadataResource,
      metadataProfile: "mcp-2026-07-28",
    }),
  ];
}
