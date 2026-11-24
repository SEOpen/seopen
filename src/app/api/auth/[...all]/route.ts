import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";
import { signupOpen } from "@/lib/signup-open";
import { TURNSTILE_HEADER, verifyTurnstile } from "@/lib/turnstile";

const betterAuth = toNextJsHandler(auth);

export const { GET } = betterAuth;

/** The one auth path Turnstile guards; the sign-up form's widget answers for the same one. */
const SIGN_UP_PATH = "/api/auth/sign-up/email";

/**
 * Every POST goes to Better Auth as it is, except an email sign-up while sign-up is open
 * (src/lib/signup-open.ts): Cloudflare Turnstile checks it first (src/lib/turnstile.ts), and a
 * failed check gets a 403, or a 503 when the check can't run, before Better Auth runs. Closed,
 * Better Auth refuses the sign-up anyway, so the check is skipped and nothing about the closed beta
 * changes. Google sign-up needs no check: Google's consent screen is its own.
 *
 * The path is compared without trailing slashes and in lower case, so a variant spelling is checked
 * too, never waved through; Better Auth itself only answers the exact path.
 */
export async function POST(request: Request): Promise<Response> {
  if (signupOpen() && new URL(request.url).pathname.replace(/\/+$/, "").toLowerCase() === SIGN_UP_PATH) {
    const verdict = await verifyTurnstile(request.headers.get(TURNSTILE_HEADER));
    if (!verdict.ok) return Response.json({ code: verdict.code, message: verdict.message }, { status: verdict.status });
  }
  return betterAuth.POST(request);
}
