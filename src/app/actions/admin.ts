"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { addAdmin, assertAdmin, removeAdmin, type AdminResult } from "@/lib/admin/access";

export type AdminFormState = (AdminResult & { value?: string }) | null;

/** "Add an admin" on Admin → Users. Keeps the typed address after an error. */
export async function addAdminFromForm(_prev: AdminFormState, formData: FormData): Promise<AdminFormState> {
  await assertAdmin();
  const email = String(formData.get("email") ?? "");
  try {
    const result = await addAdmin(email);
    if (result.ok) refresh();
    return result.ok ? result : { ...result, value: email };
  } catch (err) {
    console.error("[admin] add admin failed", err);
    return { ok: false, message: err instanceof Error ? err.message : "That didn't work. Try again.", value: email };
  }
}

/** Remove on Admin → Users. */
export async function removeAdminFromForm(formData: FormData): Promise<ActionResult> {
  await assertAdmin();
  const result = await removeAdmin(z.string().min(1).parse(formData.get("userId")));
  if (!result.ok) return { error: result.message };
  refresh();
}
