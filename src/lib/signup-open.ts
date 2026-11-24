/**
 * Whether public sign-up is open: SEOPEN_SIGNUP_OPEN=1. Off by default. It is the one switch for
 * all of it, and everything reads it through this function: email and Google sign-up in Better Auth
 * (src/lib/auth/index.ts), the Free workspace and inbox claims (src/lib/signup.ts), the /sign-up
 * page, and the site's calls to action (src/components/site/beta.ts).
 *
 * The server reads it when a function starts and on each request; the static site pages read it at
 * build time. Some hosts only give a deployment the variables it was built with, so changing it means
 * a redeploy either way.
 */
export const signupOpen = () => process.env.SEOPEN_SIGNUP_OPEN === "1";
