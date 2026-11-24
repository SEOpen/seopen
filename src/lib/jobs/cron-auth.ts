import { createHash, timingSafeEqual } from "node:crypto";

/** Hashing both sides first gives timingSafeEqual equal lengths, so a wrong guess learns nothing from its length either. */
const digest = (s: string) => createHash("sha256").update(s).digest();

/** Whether a request's Authorization header is `Bearer <CRON_SECRET>`, as Vercel's cron sends it. Nothing passes without a secret. */
export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false;
  return timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}
