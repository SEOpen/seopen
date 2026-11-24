import { after } from "next/server";
import { type OutgoingEmail, sendEmail } from "@/lib/email";

/**
 * Sends an account email once the response has gone, with Next's after(). The forms answer every
 * address the same way, so the time they take to answer must not differ either: Better Auth answers
 * a reset for an unknown address without sending, and only fakes the database lookup. Sent inside
 * the request, the email's round trip to Resend would tell anyone timing it which addresses have
 * an account.
 *
 * Outside a request (scripts/create-owner.ts, tests) after() throws, so the email goes straight
 * away and the caller waits for it. A failed send is logged and never thrown: after the response
 * nobody is there to see it, and inside one an error would answer differently from a success.
 */
export function sendAfterResponse(what: string, msg: OutgoingEmail): Promise<void> {
  const send = () => sendEmail(msg).catch((err) => console.error(`[auth] ${what} email not sent:`, err instanceof Error ? err.message : err));
  try {
    after(send);
    return Promise.resolve();
  } catch {
    return send();
  }
}
