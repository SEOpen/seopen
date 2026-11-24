import { hkdfSync } from "node:crypto";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { after } from "next/server";
import { db } from "@/db";
import { track } from "@/lib/analytics/server";
import { isDisposableEmail } from "@/lib/billing/disposable";
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
import { firstVisitOnCreate } from "@/lib/first-visit";
import { inboxTakenMessage, type OutgoingEmail, resetPasswordMessage, sendEmail, verifyEmailMessage } from "@/lib/email";
import { CONFIRM_LINK_SECONDS, claimBeforeVerifying, clearSignupPassword, confirmLink, openFreeWorkspace, purgeStaleUnconfirmed, refuseTakenInbox, reopenDate } from "@/lib/signup";
import { signupOpen } from "@/lib/signup-open";
import { queueWelcomeEmail } from "@/lib/welcome-email";
import { CLIENT_IP_HEADER } from "@/lib/web/client-ip";
import { authBaseUrl } from "./base-url";
import { revokeResetLinks } from "./reset-links";
import { revokeAgentAccess } from "./revoke-agents";
import { noLoginPlugin } from "./no-login-plugin";
import { OAUTH_DISABLED_PATHS, oauthPlugins } from "./oauth";

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
 * Sign-up is closed unless SEOPEN_SIGNUP_OPEN=1 (src/lib/signup-open.ts), read once when the server
 * starts. Closed, accounts are made by scripts/create-owner.ts or by a beta invite from
 * /admin/waitlist (src/lib/invites.ts). Open, email and Google sign-up open together, and
 * src/lib/signup.ts gives a verified sign-up its Free workspace and keeps one per inbox.
 */
const signupClosed = !signupOpen();

/**
 * Sends an account email once the response has gone, with Next's after(), as the welcome email
 * does. The forms answer every address the same way, so the time they take to answer must not
 * differ either: a sign-up for a new address sends a confirmation, one for an address with an
 * account sends "you already have one", and one for an address still waiting on its confirmation
 * sends nothing. Sent inside the request, the email's round trip to Resend would make the last
 * case answer faster and tell anyone timing it that someone signed up with that address in the
 * last day. The reset form is the same: Better Auth answers an unknown address without sending,
 * and only fakes the database lookup, so it moves too.
 *
 * Outside a request (scripts/create-owner.ts, tests) after() throws, so the email goes straight
 * away and the caller waits for it. A failed send is logged and never thrown: after the response
 * nobody is there to see it, and inside one an error would answer differently from a success.
 */
function sendAfterResponse(what: string, msg: OutgoingEmail): Promise<void> {
  const send = () => sendEmail(msg).catch((err) => console.error(`[auth] ${what} email not sent:`, err instanceof Error ? err.message : err));
  try {
    after(send);
    return Promise.resolve();
  } catch {
    return send();
  }
}

/** Tells an inbox why it got no new account; the sign-up form can't say, or it would show who has one. */
function sendInboxTaken(email: string, until?: Date) {
  return sendAfterResponse("inbox taken", { to: email, ...inboxTakenMessage({ signInUrl: `${authBaseUrl()}/sign-in`, until: until && reopenDate(until) }) });
}

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
  disabledPaths: OAUTH_DISABLED_PATHS,
  // Counted in Postgres so every instance shares one limit. On in production only.
  rateLimit: {
    storage: "database",
    customRules: {
      "/sign-in/email": { window: 10 * 60, max: 5 },
      "/sign-up/email": { window: 10 * 60, max: 3 },
      "/request-password-reset": { window: 10 * 60, max: 3 },
      "/send-verification-email": { window: 10 * 60, max: 3 },
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
    sendResetPassword: async ({ user, url }) => sendAfterResponse("reset password", { to: user.email, ...resetPasswordMessage(url) }),
    // Sessions go above; MCP keys and connected apps would outlive them, so a reset cuts those off
    // too (src/lib/auth/revoke-agents.ts). Runs after the new password is saved; a failure fails
    // the request, so it never reports success with access still open.
    onPasswordReset: async ({ user }) => {
      await revokeAgentAccess(user.id);
      // Any other reset or invite link the account still has would set the password again.
      await revokeResetLinks(user.id);
    },
    // Only reachable with sign-up open. An unconfirmed account gets nothing: sign-in offers its link
    // again. Every email here goes after the response (sendAfterResponse), so sending nothing is
    // no quicker than sending.
    onExistingUserSignUp: async ({ user }) => {
      if (user.emailVerified) await sendInboxTaken(user.email);
    },
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: CONFIRM_LINK_SECONDS,
    // Every confirmation link lands on /set-password (src/lib/signup.ts, confirmLink).
    sendVerificationEmail: async ({ user, url }) => sendAfterResponse("confirmation", { to: user.email, ...verifyEmailMessage(confirmLink(url)) }),
    // A self sign-up's Free workspace (src/lib/signup.ts), which does nothing with sign-up closed.
    // Then the password typed at sign-up goes, and so does every session, whether sign-up is open
    // or not: whoever typed it may not own the inbox (clearSignupPassword).
    beforeEmailVerification: async (user) => {
      await claimBeforeVerifying(user, authBaseUrl());
      await clearSignupPassword(user.id);
    },
    afterEmailVerification: async (user) => {
      // The session made straight after tries again, so a failure here only costs a retry.
      await openFreeWorkspace(user.id).catch((err) => console.error("[signup] workspace after verification:", err));
    },
  },
  socialProviders: googleLoginConfigured
    ? {
        google: {
          clientId: process.env.GOOGLE_CLIENT_ID!,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
          scope: ["openid", "email", "profile"],
          disableSignUp: signupClosed,
          // Google vouches for this address, so an unconfirmed sign-up stops holding it, however
          // fresh (src/lib/signup.ts). Better Auth reads the profile, and so runs this, before it
          // looks for an existing account, in the callback and in /sign-in/social with an ID token
          // alike, so the inbox's owner gets a new account instead of "unverified, can't link".
          // Maps nothing; does nothing with sign-up closed.
          mapProfileToUser: async (profile) => {
            if (profile.email_verified) await purgeStaleUnconfirmed(profile.email, { vouched: true });
            return {};
          },
        },
      }
    : {},
  // No provider is trusted outright: Google links to an existing account only when it reports the
  // email verified. Trusting it would skip that check and hand over the account that owns the address.
  account: { accountLinking: { enabled: true } },
  // Set only by the user create hook below, never from a request (`input: false`), and never sent
  // to the browser. Declared so Better Auth writes them.
  user: {
    additionalFields: {
      firstSource: { type: "string", required: false, input: false, returned: false },
      firstReferrerHost: { type: "string", required: false, input: false, returned: false },
      firstLandingPath: { type: "string", required: false, input: false, returned: false },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    // Signed session copy in a cookie, so proxy.ts can check most requests without the database.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  hooks: {
    // A new email sign-up replaces an unconfirmed one past its link (src/lib/signup.ts), instead of
    // being answered as a duplicate. Does nothing with sign-up closed.
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/sign-up/email") await purgeStaleUnconfirmed(ctx.body?.email);
    }),
    // Changing the password while signing out every other session is the other way an account is
    // taken back, so it cuts off MCP keys and connected apps too, as a reset does (onPasswordReset).
    // Only after the change went through: a wrong current password changes nothing.
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/change-password" || ctx.body?.revokeOtherSessions !== true) return;
      if (ctx.context.returned instanceof APIError) return;
      const userId = ctx.context.session?.user.id;
      if (userId) await revokeAgentAccess(userId);
    }),
  },
  databaseHooks: {
    user: {
      create: {
        // Throwaway addresses can't make an account. Bots are turned away before this, by Turnstile in
        // src/app/api/auth/[...all]/route.ts (src/lib/signup.ts).
        before: async (user, ctx) => {
          if (isDisposableEmail(user.email)) {
            throw new APIError("BAD_REQUEST", { message: "Use a permanent email address. Throwaway inboxes can't sign up." });
          }
          // One Free account per inbox, for self sign-ups with sign-up open (src/lib/signup.ts).
          await refuseTakenInbox(user.email, ctx?.path, (r) => sendInboxTaken(user.email, r.kind === "cooldown" ? r.until : undefined));
          // Where a self sign-up's first site visit came from (src/lib/first-visit.ts). Set here, as
          // the account is made, so a later sign-in never changes it.
          return { data: { ...user, ...(await firstVisitOnCreate(ctx?.path, ctx?.body)) } };
        },
        after: async (user) => track(user.id, "user_signed_up"),
      },
    },
    session: {
      create: {
        // Every way into an account makes a session here, so this is the one place to welcome it.
        // With sign-up open it's also where a verified sign-up with no workspace gets its Free one
        // first: every Google sign-up, and a retry if the confirmation link's attempt failed.
        after: async (session) => {
          await openFreeWorkspace(session.userId).catch((err) => console.error("[signup] workspace on sign-in:", err));
          queueWelcomeEmail(session.userId);
        },
      },
    },
  },
  // nextCookies stays last: it reads the cookies the other plugins' hooks set.
  plugins: [...oauthPlugins(authBaseUrl()), noLoginPlugin(), nextCookies()],
});

export type AuthSession = typeof auth.$Infer.Session;
