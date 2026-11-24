import type { BetterAuthOptions } from "better-auth";
import type { DBFieldAttribute } from "better-auth/db";
import type { ReactNode } from "react";

/**
 * Whether strangers can make their own accounts. This repo has no public sign-up: accounts are made
 * by `pnpm owner:create` or by an admin. Core asks for the parts below as `@/public-signup/<part>`,
 * which resolve to `none/` here, and to a hosted service's own `hosted/` folder where one exists
 * (`publicSignupFile` in file.ts). `none/` refuses whatever the environment says, so no setting can
 * open sign-up on a copy that doesn't have the code for it.
 */

type EmailVerification = NonNullable<BetterAuthOptions["emailVerification"]>;
type Account = { id: string; email: string; emailVerified: boolean };
/** The Better Auth endpoint making an account, and its body. Null outside an endpoint, as an admin's invite is. */
export type CreateContext = { path?: string; body?: unknown } | null | undefined;

/** `@/public-signup/server`. */
export interface PublicSignup {
  /** Read once, when the server starts: whether email and Google may make new accounts. */
  open(): boolean;
  /** Better Auth endpoints this copy doesn't answer. */
  disabledPaths: readonly string[];
  /** Confirming a new account's address. None where nobody can sign up. */
  emailVerification?: EmailVerification;
  /** Columns on `users` the sign-up writes, declared so Better Auth saves them. */
  userFields: Record<string, DBFieldAttribute>;
  /** A check before Better Auth sees a POST: an answer to send instead, or null to carry on. */
  guard(request: Request): Promise<Response | null>;
  /** Before an email sign-up runs. May replace the body it runs with. */
  beforeEmailSignUp(body: Record<string, unknown> | undefined): Promise<Record<string, unknown> | void>;
  /** Someone signed up with an address that has an account. */
  onExistingUser(user: Account): Promise<void>;
  /** Google vouched for an address, before Better Auth looks for its account. */
  beforeGoogleProfile(profile: { email: string; email_verified: boolean }): Promise<void>;
  /** Before any account is made. Throws to refuse it; the answer is added to the new row. */
  beforeCreate(user: { email: string }, ctx: CreateContext): Promise<Record<string, unknown>>;
  /** After every sign-in. Never throws. */
  onSession(userId: string): Promise<void>;
}

/** `@/public-signup/page`: what the sign-in page says about making an account. */
export interface PublicSignupPage {
  /** Extra messages for the sign-in page's `?error=` codes. */
  signInErrors(): Record<string, string>;
  /** The line under the sign-in form. */
  SignInFooter(): ReactNode;
}

/**
 * `@/public-signup/client`, `UnconfirmedHelp`: help inside the sign-in form for someone whose
 * password is right and whose address isn't confirmed. `next` is where they were going.
 */
export type UnconfirmedHelp = (props: { email: string; next: string }) => ReactNode;
