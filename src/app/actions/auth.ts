"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { safeCallback } from "@/lib/auth/redirect";
import { requireSession } from "@/lib/auth/session";

export async function signOut() {
  await auth.api.signOut({ headers: await headers() }).catch(() => undefined);
  redirect("/sign-in");
}

export type SetPasswordState = { error: string } | null;

/**
 * /set-password, straight after a confirmation link cleared the password typed at sign-up
 * (clearSignupPassword in src/lib/signup.ts). Better Auth's setPassword only sets a password on an
 * account that has none, and only from a session made in the last day, so this can't change a
 * password someone already has.
 */
export async function setFirstPassword(_prev: SetPasswordState, form: FormData): Promise<SetPasswordState> {
  await requireSession();
  const next = safeCallback(form.get("next"));
  const newPassword = String(form.get("password") ?? "");
  if (newPassword !== String(form.get("confirm") ?? "")) return { error: "The two passwords don't match." };
  try {
    await auth.api.setPassword({ body: { newPassword }, headers: await headers() });
  } catch (err) {
    const code = (err as { body?: { code?: string } }).body?.code;
    if (code === "PASSWORD_ALREADY_SET") redirect(next);
    if (code === "PASSWORD_TOO_SHORT") return { error: "Use 8 characters or more." };
    if (code === "PASSWORD_TOO_LONG") return { error: "That password is too long. Use 128 characters or fewer." };
    if (code === "SESSION_NOT_FRESH") return { error: "This page has been open too long. Sign out, then choose a password with Forgot password on the sign-in page." };
    throw err;
  }
  redirect(next);
}
