/**
 * Sets a new password for an existing account, from the server, for a copy that can't send email.
 * "Forgot your password?" needs RESEND_API_KEY; without it the operator runs this instead. The
 * password is typed here, hidden, and never leaves this terminal. It signs the account out
 * everywhere, revokes its API keys, disconnects its connected apps and voids any reset links it
 * had, as a reset does: whoever held the account could keep working through any of them.
 *
 *   pnpm user:password you@example.com
 *   docker compose exec web pnpm user:password you@example.com
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { auth } from "@/lib/auth";
import { revokeResetLinks } from "@/lib/auth/reset-links";
import { revokeAgentAccess } from "@/lib/auth/revoke-agents";

const email = process.argv.slice(2).find((a) => !a.startsWith("--"))?.trim().toLowerCase();

/** Reads a line without echoing it. */
function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, done) {
      if (!muted) process.stdout.write(chunk);
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

async function main() {
  if (!email) throw new Error("Name the account: pnpm user:password you@example.com");
  if (!process.stdin.isTTY) throw new Error("Run this in a terminal so the password can be typed.");
  const ctx = await auth.$context;
  const found = await ctx.internalAdapter.findUserByEmail(email);
  if (!found) throw new Error(`${email} has no account. pnpm owner:create makes one.`);
  const userId = found.user.id;

  const password = await askHidden(`New password for ${email} (8 characters or more): `);
  if (password.length < 8) throw new Error("Too short. Use 8 characters or more.");
  if ((await askHidden("Repeat it: ")) !== password) throw new Error("The two passwords don't match.");
  const hash = await ctx.password.hash(password);

  // An account made with --no-password, or through Google only, has no password yet: this adds one.
  const credential = (await ctx.internalAdapter.findAccounts(userId)).find((a) => a.providerId === "credential");
  if (credential) await ctx.internalAdapter.updateAccount(credential.id, { password: hash });
  else await ctx.internalAdapter.linkAccount({ userId, providerId: "credential", accountId: userId, password: hash });
  await ctx.internalAdapter.deleteUserSessions(userId);
  const { keys, apps } = await revokeAgentAccess(userId);
  await revokeResetLinks(userId);
  console.log(`Set a new password for ${email} and signed it out everywhere. API keys revoked: ${keys}. Connected apps disconnected: ${apps}. Sign in at ${auth.options.baseURL}/sign-in`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
