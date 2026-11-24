"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { refusalResult, type ActionResult } from "@/lib/action-result";
import { requireSession } from "@/lib/auth/session";
import { projectActionRefusal } from "@/lib/billing/workspace";
import { plainActionFailure } from "@/lib/dataforseo/failure-copy";
import { OpError } from "@/lib/ops";
import { requireProject } from "@/lib/projects";
import { splitKeywords } from "./href";
import { createBriefOp, deleteBrief, updateBriefFillOp } from "./ops";
import { PAGE_TYPES, type BriefOption } from "./types";

const id = z.number().int().positive().max(2_147_483_647);
const text = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
};

/**
 * Creates a brief from the form the price was shown on. `maxCredits` is that price, so a lookup that
 * stopped being saved in between is asked about again rather than bought.
 */
export async function createBrief(projectId: number, maxCredits: number, form: FormData): Promise<ActionResult> {
  const user = await requireSession();
  const { scope } = await requireProject(id.parse(projectId));
  const pageType = z.enum(PAGE_TYPES).parse(text(form, "type"));
  let made;
  try {
    made = await createBriefOp(
      scope,
      { userId: user.id, source: "app" },
      { keyword: text(form, "q"), pageType, x: text(form, "x") || null, y: text(form, "y") || null, merged: splitKeywords(text(form, "merge")) },
      { maxCredits: z.number().int().min(0).parse(maxCredits) },
    );
  } catch (e) {
    if (e instanceof OpError) return { error: e.message, upgradable: e.refusal?.upgradable };
    return { error: plainActionFailure(e, "content-briefs.create") };
  }
  if (made.state === "needs_credits") return { error: `${made.message} The price changed since this page loaded, so nothing was bought. Reload to see it.` };
  if (made.state !== "created") return { error: "Nothing was created. Try again." };
  redirect(`/keywords/briefs/${made.id}`);
}

/** Saves the angle and the owner-only answers. */
export async function saveBriefAnswers(projectId: number, briefId: number, form: FormData): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(id.parse(projectId));
  const inputs: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (k.startsWith("input:") && typeof v === "string") inputs[k.slice(6)] = v;
  try {
    await updateBriefFillOp(scope, id.parse(briefId), { angle: text(form, "angle"), inputs });
  } catch (e) {
    if (e instanceof OpError) return { error: e.message, upgradable: e.refusal?.upgradable };
    throw e;
  }
  refresh();
}

/** Saves the options list, held to the page type's rules. Rows are `name:0`, `url:0` and so on. */
export async function saveBriefOptions(projectId: number, briefId: number, form: FormData): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(id.parse(projectId));
  const rows = new Map<number, Partial<BriefOption>>();
  for (const [k, v] of form.entries()) {
    const m = /^(name|url|price|priceCheckedOn|drawback):(\d{1,2})$/.exec(k);
    if (!m || typeof v !== "string") continue;
    const i = Number(m[2]);
    rows.set(i, { ...rows.get(i), [m[1]]: v });
  }
  const options = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
  try {
    await updateBriefFillOp(scope, id.parse(briefId), { options: options as BriefOption[] });
  } catch (e) {
    if (e instanceof OpError) return { error: e.message, upgradable: e.refusal?.upgradable };
    throw e;
  }
  refresh();
}

export async function deleteBriefAction(projectId: number, briefId: number): Promise<ActionResult> {
  await requireSession();
  const { scope } = await requireProject(id.parse(projectId));
  const refusal = await projectActionRefusal(scope);
  if (refusal) return refusalResult(refusal);
  await deleteBrief(scope, id.parse(briefId));
  redirect("/keywords/briefs");
}
