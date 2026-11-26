import { hkdfSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import type { DBFieldAttribute } from "better-auth/db";
import { nextCookies } from "better-auth/next-js";
import { db } from "@/db";
import { track } from "@/lib/analytics/server";
import {
  accounts,
  jwks,
  oauthAccessTokens,
  oauthClientAssertions,
  oauthClientResources,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  oauthResources,
  rateLimits,
  sessions,
  users,
  verifications,
} from "@/db/schema";
import { resetPasswordMessage } from "@/lib/email";
import { CLIENT_IP_HEADER } from "@/lib/web/client-ip";
import { signup } from "@/public-signup/server";
import { authBaseUrl } from "./base-url";
import { RESET_PASSWORD_PATH, resetPageLink, revokeResetLinks } from "./reset-links";
import { revokeAgentAccess } from "./revoke-agents";
import { noLoginPlugin } from "./no-login-plugin";
import { OAUTH_DISABLED_PATHS, oauthPlugins } from "./oauth";
import { promptForAuthorize, requireStandingConsent } from "./oauth-grants";
import { sendAfterResponse } from "./send-after";
import { signOutElsewherePlugin } from "./sign-out-elsewhere-plugin";

export const googleLoginConfigured = Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

export { authBaseUrl } from "./base-url";

/**
 * BETTER_AUTH_SECRET if set; otherwise derived from SEOPEN_SECRET_KEY with HKDF under its own
 * label, so deploys need no second secret and the two keys never sign the same thing.
 * Changing either signs everyone out.
 */
export function authSecret(): string | undefined {
  if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
  const key = Buffer.from(process.env.SEOPEN_SECRET_KEY ?? "", "base64");
  if (key.length !== 32) return undefined;
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "seopen-better-auth-v1", 32)).toString("base64");
}

/**
 * Strangers can't make accounts here: an operator makes them (scripts/create-owner.ts, or Admin's
 * invites, src/lib/invites.ts). A hosted service can add its own sign-up, which says through
 * `@/public-signup/server` whether email and Google may make accounts (src/lib/public-signup/types.ts).
 * Read once, when the server starts.
 */
const signupClosed = !signup.open();

/**
 * Accounts. Email and password with verification, plus Google with
 * login scopes only; Search Console and GA4 are asked for separately by /api/google/connect.
 *
 * The app is also the OAuth authorization server for its MCP endpoint (./oauth.ts).
 */
export const auth = betterAuth({
  baseURL: authBaseUrl(),
  secret: authSecret(),
  database: drizzleAdapter(db, {
    provider: "pg",
    usePlural: true,
    schema: {
      users,
      sessions,
      accounts,
      verifications,
      rateLimits,
      jwks,
      oauthClients,
      oauthResources,
      oauthClientResources,
      oauthRefreshTokens,
      oauthAccessTokens,
      oauthConsents,
      oauthClientAssertions,
    },
  }),
  trustedOrigins: [authBaseUrl()],
  // The visitor's address, set only by the auth route from the proxy's trusted header
  // (src/lib/web/client-ip.ts). Without one, Better Auth falls back to a single shared bucket.
  advanced: { ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] } },
  disabledPaths: [...OAUTH_DISABLED_PATHS, ...signup.disabledPaths],
  // Counted in Postgres so every instance shares one limit. On in production only.
  rateLimit: {
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 10 * 60, max: 5 },
      "/sign-up/email": { window: 10 * 60, max: 3 },
      "/request-password-reset": { window: 10 * 60, max: 3 },
      "/send-verification-email": { window: 10 * 60, max: 3 },
      // It checks the current password, so it's a place to guess one.
      "/change-password": { window: 10 * 60, max: 5 },
      // Anyone may register an app. Loose enough for a connector service registering from shared
      // addresses, tight enough that a script can't fill the table quickly; the daily `mcp.prune`
      // job deletes apps 90 days old that have no consent (src/lib/auth/retention.ts).
      "/oauth2/register": { window: 60, max: 30 },
    },
  },
  emailAndPassword: {
    enabled: true,
    disableSignUp: signupClosed,
    requireEmailVerification: true,
    minPasswordLength: 8,
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    // The mailed link opens the reset page with the token in the query, not Better Auth's
    // /reset-password/<token>, so the token never sits in a path (resetPageLink).
    sendResetPassword: async ({ user, token }) => sendAfterResponse("reset password", { to: user.email, ...resetPasswordMessage(resetPageLink(authBaseUrl(), token)) }),
    // Sessions go above; MCP keys and connected apps would outlive them, so a reset cuts those off
    // too (src/lib/auth/revoke-agents.ts). Runs after the new password is saved; a failure fails
    // the request, so it never reports success with access still open.
    onPasswordReset: async ({ user }) => {
      await revokeAgentAccess(user.id);
      // Any other reset or invite link the account still has would set the password again.
      await revokeResetLinks(user.id);
    },
    // Only reachable with sign-up open.
    onExistingUserSignUp: ({ user }) => signup.onExistingUser(user),
  },
  emailVerification: signup.emailVerification,
  socialProviders: googleLoginConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          scope: ["openid", "email", "profile"],
          disableSignUp: signupClosed,
          // Runs before Better Auth looks for an existing account, in the callback and in
          // /sign-in/social with an ID token alike. Maps nothing.
          mapProfileToUser: async (profile) => {
            await signup.beforeGoogleProfile(profile);
            return {};
          },
        },
      }
    : {},
  // No provider is trusted outright: Google links to an existing account only when it reports the
  // email verified. Trusting it would skip that check and hand over the account that owns the address.
  account: { accountLinking: { enabled: true } },
  // Set only by the user create hook below, never from a request, and never sent to the browser.
  // Typed as no fields, so nothing here reads or sends one by name.
  user: { additionalFields: signup.userFields as Record<never, DBFieldAttribute> },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // No cookieCache: a signed copy of the session in a cookie goes on working until it runs out,
    // whatever happened to the row, so a password reset or a sign-out would leave the other browser
    // in, with time to make an API key or connect an app that outlives it. Every check reads the row.
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Whatever the request asked for: a new password always signs out every other session.
      if (ctx.path === "/change-password") return { context: { body: { ...ctx.body, revokeOtherSessions: true } } };
      // Whatever the request asked for: a reset link lands on the reset page and nowhere else. The link
      // adds its token to the address it lands on, so no other page gets to see one.
      if (ctx.path === "/request-password-reset") return { context: { body: { ...ctx.body, redirectTo: RESET_PASSWORD_PATH } } };
      // The provider swaps a code and refreshes a token without looking at the consent (./oauth-grants.ts).
      if (ctx.path === "/oauth2/token") return void (await requireStandingConsent(ctx.body));
      // An app whose callback is on the machine itself asks every time, stored consent or not. Only
      // for a request that came to this endpoint: the consent page's answer runs authorize again
      // from inside the provider, with the prompt it has just satisfied taken off, and comes through here too.
      if (ctx.path === "/oauth2/authorize" && ctx.request && new URL(ctx.request.url).pathname.endsWith("/oauth2/authorize")) {
        // The provider reads a POST's parameters from its form body and a GET's from the query.
        const posted = ctx.request.method === "POST";
        const prompt = promptForAuthorize(posted ? ctx.body : ctx.query);
        if (!prompt) return;
        return { context: posted ? { body: { ...ctx.body, prompt } } : { query: { ...ctx.query, prompt } } };
      }
      if (ctx.path !== "/sign-up/email") return;
      const body = await signup.beforeEmailSignUp(ctx.body);
      if (body) return { context: { body } };
    }),
    // Changing the password is the other way an account is taken back, so it cuts off MCP keys,
    // connected apps and unused reset links too, as a reset does (onPasswordReset).
    // Only after the change went through: a wrong current password changes nothing.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password") return;
      if (ctx.context.returned instanceof APIError) return;
      const userId = ctx.context.session?.user.id;
      if (!userId) return;
      await revokeAgentAccess(userId);
      await revokeResetLinks(userId);
    }),
  },
  databaseHooks: {
    user: {
      create: {
        // Invites and admin accounts are made outside any endpoint, so they have no path.
        before: async (user, ctx) => ({ data: { ...user, ...(await signup.beforeCreate(user, ctx)) } }),
        after: async (user) => track(user.id, "user_signed_up"),
      },
    },
    session: {
      create: {
        // Every way into an account makes a session here.
        after: (session) => signup.onSession(session.userId),
      },
    },
  },
  // nextCookies stays last: it reads the cookies the other plugins' hooks set.
  plugins: [...oauthPlugins(authBaseUrl()), noLoginPlugin(), signOutElsewherePlugin(), nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
