import type { PublicSignup } from "../types";

/**
 * No public sign-up (types.ts). It reads no settings, and it turns off Better Auth's sign-up and
 * email confirmation endpoints as well as refusing new accounts: the accounts an operator makes are
 * counted as confirmed, so nothing here needs them.
 */
export const signup: PublicSignup = {
  open: () => false,
  disabledPaths: ["/sign-up/email", "/send-verification-email", "/verify-email"],
  userFields: {},
  guard: async () => null,
  beforeEmailSignUp: async () => undefined,
  onExistingUser: async () => undefined,
  beforeGoogleProfile: async () => undefined,
  beforeCreate: async () => ({}),
  onSession: async () => undefined,
};
