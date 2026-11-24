/**
 * Cloudflare Turnstile on the email sign-up (src/app/api/auth/[...all]/route.ts). The form
 * (src/components/auth/sign-up-form.tsx) gets a one-use token from the widget and sends it in
 * TURNSTILE_HEADER; this asks Cloudflare whether it's good before Better Auth runs. It works on any
 * host.
 *
 * Env: TURNSTILE_SITE_KEY (public, shown to the widget) and TURNSTILE_SECRET_KEY (server only), from
 * a widget in the Cloudflare dashboard (Turnstile) listing the hosts the form is on. Without the
 * secret, a production build refuses every email sign-up instead of letting bots through, and
 * development lets them through with a warning, so local sign-ups need no account. Cloudflare's
 * published test keys work locally too (docs/self-hosting.md).
 */

type Env = Record<string, string | undefined>;

export const TURNSTILE_HEADER = "x-turnstile-token";
/** The widget's action, checked on the answer, so a token from some other widget can't be replayed here. */
export const TURNSTILE_ACTION = "sign-up";
const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Cloudflare's documented maximum token length. */
const MAX_TOKEN = 2048;

export const turnstileSiteKey = (env: Env = process.env): string | null => env.TURNSTILE_SITE_KEY?.trim() || null;

export type TurnstileVerdict = { ok: true } | { ok: false; status: 403 | 503; code: "BOT_DETECTED" | "SIGNUP_CHECK_UNAVAILABLE"; message: string };

const failed: TurnstileVerdict = { ok: false, status: 403, code: "BOT_DETECTED", message: "The sign-up check didn't pass. Reload the page and try again." };
const unavailable: TurnstileVerdict = {
  ok: false,
  status: 503,
  code: "SIGNUP_CHECK_UNAVAILABLE",
  message: "Sign-up can't check new accounts right now. Try again in a few minutes.",
};

let warnedUnset = false;

/**
 * Whether the token passes. Fails closed: no answer from Cloudflare, or an answer this can't read,
 * refuses the sign-up rather than letting it through.
 */
export async function verifyTurnstile(
  token: string | null,
  { env = process.env, fetchImpl = fetch }: { env?: Env; fetchImpl?: typeof fetch } = {},
): Promise<TurnstileVerdict> {
  const secret = env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) {
    if (env.NODE_ENV === "production") {
      if (!warnedUnset) console.error("[turnstile] TURNSTILE_SECRET_KEY isn't set, so every email sign-up is refused");
      warnedUnset = true;
      return unavailable;
    }
    if (!warnedUnset) console.warn("[turnstile] TURNSTILE_SECRET_KEY isn't set; development lets sign-ups through unchecked");
    warnedUnset = true;
    return { ok: true };
  }
  if (!token || token.length > MAX_TOKEN) return failed;

  let answer: { success?: unknown; action?: unknown };
  try {
    const res = await fetchImpl(VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({ secret, response: token }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.error(`[turnstile] siteverify answered ${res.status}`);
      return unavailable;
    }
    answer = await res.json();
  } catch (err) {
    console.error("[turnstile] siteverify failed", err instanceof Error ? err.message : err);
    return unavailable;
  }
  return answer.success === true && answer.action === TURNSTILE_ACTION ? { ok: true } : failed;
}
