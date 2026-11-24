/**
 * Creates the owner's account. Sign-up is closed, so this is the only
 * way an account appears. The email counts as verified; the password is typed here, hidden, and
 * never leaves this terminal. With --no-password the account gets none, and the owner sets one
 * through "Forgot your password?" once email works.
 *
 *   pnpm owner:create                      # the contact address, NEXT_PUBLIC_SEOPEN_CONTACT_EMAIL, when it is set
 *   pnpm owner:create someone@example.com --no-password
 *   pnpm owner:create someone@example.com --no-password --customer
 *
 * With --customer the account gets a workspace of its own instead of joining the owner's, on the plan
 * the plan policy gives a workspace the operator makes (`newWorkspacePlan`, src/lib/billing/policy.ts).
 * Use it for a second person on a self-hosted copy, or for the sandbox run with a second account.
 *
 * Against production: run with production's DATABASE_URL and DATABASE_CA_CERT in the environment.
 */
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, workspaceMembers, workspaces } from "@/db/schema";
import { auth } from "@/lib/auth";
import { contactEmail } from "@/lib/instance";
import { OWNER_WORKSPACE_ID } from "@/lib/workspace";
import { hooks } from "@/plan-policy/hooks";

const args = process.argv.slice(2);
// Without an address, the contact address; a copy that sets none has to name one.
const given = args.find((a) => !a.startsWith("--")) ?? contactEmail();
if (!given) {
  console.error("Name the account's email: pnpm owner:create you@example.com");
  process.exit(1);
}
const email = given.trim().toLowerCase();
const withPassword = !args.includes("--no-password");
const customer = args.includes("--customer");

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
  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new Error(`${email} already has an account. Use "Forgot your password?" to change its password.`);

  let hash: string | null = null;
  if (withPassword) {
    if (!process.stdin.isTTY) throw new Error("Run this in a terminal so the password can be typed, or pass --no-password.");
    const password = await askHidden(`Password for ${email} (8 characters or more): `);
    if (password.length < 8) throw new Error("Too short. Use 8 characters or more.");
    if ((await askHidden("Repeat it: ")) !== password) throw new Error("The two passwords don't match.");
    hash = await (await auth.$context).password.hash(password);
  }

  const ctx = await auth.$context;
  const user = await ctx.internalAdapter.createUser({ email, name: "", emailVerified: true }, { method: "admin" });
  if (hash) await ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash });
  // The owner's account works in the owner's workspace, which holds everything from before tenancy.
  let workspaceId = OWNER_WORKSPACE_ID;
  if (customer) [{ id: workspaceId }] = await db.insert(workspaces).values({ name: email.split("@")[0], plan: hooks.newWorkspacePlan("operator") }).returning({ id: workspaces.id });
  await db.insert(workspaceMembers).values({ workspaceId, userId: user.id, role: "owner" }).onConflictDoNothing();
  console.log(`Created ${email}${hash ? " with a password" : " without a password"} in workspace #${workspaceId}. Sign in at ${auth.options.baseURL}/sign-in`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
