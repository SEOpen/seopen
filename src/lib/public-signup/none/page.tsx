import type { PublicSignupPage } from "../types";

/** No public sign-up (../types.ts): the sign-in page says who makes accounts. */
export const signupPage: PublicSignupPage = {
  signInErrors: () => ({}),
  SignInFooter: () => (
    <p className="border-t border-line pt-4 text-center text-sm text-muted">Accounts are made by whoever runs this copy of SEOpen.</p>
  ),
};
