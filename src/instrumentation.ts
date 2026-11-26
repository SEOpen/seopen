/**
 * Runs once as the web server starts. It says in the server log when no-login mode is on
 * (src/lib/auth/no-login.ts), so nobody runs a copy without a password by accident.
 */
export function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.SEOPEN_NO_LOGIN !== "1") return;
  console.log(
    "[seopen] No-login mode is on (SEOPEN_NO_LOGIN=1): a browser on this machine opens the app signed in as its owner, with no password. " +
      "Keep the port bound to 127.0.0.1: the mode can't tell whether other machines can reach it. Remove the setting before putting this copy on a server (docs/self-hosting.md, \"Signing in\").",
  );
}
