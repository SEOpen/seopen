import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * The unsubscribe links in the recap and alert emails: the person's id with a keyed signature, so
 * the link works without signing in and nobody can turn off someone else's email by guessing an
 * id. Each list signs under its own name, so a recap link can't stop alerts or the other way round.
 * They never expire: an old email's link should still work. No `server-only`: the worker signs
 * links in the emails.
 */

/** The emails a person can unsubscribe from on their own. */
export type EmailList = "recap" | "alerts";

/** The HMAC key, derived from SEOPEN_SECRET_KEY under its own label so it never signs anything else. */
function unsubscribeKey(): Buffer {
  const key = Buffer.from(process.env.SEOPEN_SECRET_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("SEOPEN_SECRET_KEY must be set (32 random bytes, base64) to sign unsubscribe links.");
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), "seopen-recap-unsubscribe-v1", 32));
}

const sign = (userId: string, list: EmailList) => createHmac("sha256", unsubscribeKey()).update(`${list}:${userId}`).digest("base64url");

/** `<base64url user id>.<signature>`. */
export function unsubscribeToken(userId: string, list: EmailList = "recap"): string {
  return `${Buffer.from(userId, "utf8").toString("base64url")}.${sign(userId, list)}`;
}

/** The user id a token was signed for on that list, or null for anything else. */
export function verifyUnsubscribeToken(token: unknown, list: EmailList = "recap"): string | null {
  if (typeof token !== "string" || token.length > 512) return null;
  const [id, signature, extra] = token.split(".");
  if (!id || !signature || extra !== undefined) return null;
  const userId = Buffer.from(id, "base64url").toString("utf8");
  if (!userId) return null;
  const expected = Buffer.from(sign(userId, list));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given) ? userId : null;
}

/** The link in the email and its List-Unsubscribe header. It answers a one-click POST and a GET that asks first. */
export function unsubscribeUrl(origin: string, userId: string, list: EmailList = "recap"): string {
  return `${origin}/api/email/unsubscribe?t=${unsubscribeToken(userId, list)}${list === "recap" ? "" : `&list=${list}`}`;
}
