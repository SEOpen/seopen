"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import type { ActionResult } from "@/lib/action-result";
import { addAdmin, assertAdmin, removeAdmin, type AdminResult } from "@/lib/admin/access";
import { OpError } from "@/lib/ops";
import { deleteUserAsAdminOp, deleteWorkspaceAsAdminOp } from "@/lib/workspace/delete";

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

export type AdminDeleteState = { error: string } | null;

/** Delete on Admin → Workspaces → a workspace, once "delete" is typed; a refusal comes back as `error`. */
export async function deleteWorkspaceAsAdmin(_prev: AdminDeleteState, formData: FormData): Promise<AdminDeleteState> {
  const me = await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("workspaceId"));
  try {
    await deleteWorkspaceAsAdminOp(id, { userId: me.id, source: "app" }, String(formData.get("confirm") ?? ""));
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  redirect("/admin/workspaces");
}

/** Delete on Admin → Users → an account, once "delete" is typed; a refusal comes back as `error`. */
export async function deleteUserAsAdmin(_prev: AdminDeleteState, formData: FormData): Promise<AdminDeleteState> {
  const me = await assertAdmin();
  const id = z.string().min(1).parse(formData.get("userId"));
  try {
    await deleteUserAsAdminOp(id, { userId: me.id, source: "app" }, String(formData.get("confirm") ?? ""));
  } catch (e) {
    if (e instanceof OpError) return { error: e.message };
    throw e;
  }
  redirect("/admin/users");
}
