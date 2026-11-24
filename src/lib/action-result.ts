import type { Refusal } from "@/lib/billing/errors";

/**
 * What a form's Server Action returns when it says no: why, and whether Upgrade now would help.
 * A refusal is a normal answer, so it comes back as a value. Next hides a thrown message in
 * production, so a throw would lose the reason and take the page with it.
 */
export type ActionRefusal = { error: string; upgradable?: boolean };

/** Nothing when the action worked. */
export type ActionResult = ActionRefusal | void;

export const refusalResult = (refusal: Refusal): ActionRefusal => ({ error: refusal.message, upgradable: refusal.upgradable });
