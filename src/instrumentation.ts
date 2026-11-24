/**
 * Runs once as the web server starts. It says in the server log when no-login mode is on
 * (src/lib/auth/no-login.ts), so nobody runs a copy without a password by accident.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.SEOPEN_NO_LOGIN !== "1") return;
  console.log(
    "[seopen] No-login mode is on (SEOPEN_NO_LOGIN=1): a browser on this machine opens the app signed in as its owner, with no password. " +
      "Requests from anywhere else still need one. Remove the setting before putting this copy on a server (docs/self-hosting.md, \"Signing in\").",
  );
}
