import type { BillingWorkspace } from "@/lib/billing/gates";
import { formatNumber } from "@/lib/format";
import { plausibleOpen } from "@/modules/plausible/gate";
import { umamiOpen } from "@/modules/umami/gate";
import { rules } from "@/plan-policy/rules";

/**
 * The page's header line. It names Plausible and Umami only where they're open, by the same gates
 * `otherSourceChoices` hides them with on the form, so a closed workspace isn't told about either.
 */
export function newProjectDescription(ws: BillingWorkspace): string {
  const sources = ["Google Analytics", "PostHog", ...(plausibleOpen(ws) ? ["Plausible"] : []), ...(umamiOpen(ws) ? ["Umami"] : [])];
  const list = sources.length > 2 ? `${sources.slice(0, -1).join(", ")} or ${sources.at(-1)}` : sources.join(" or ");
  return `Add a site to track, and link its Search Console and its Analytics: ${list}.`;
}

/** What the new project form offers: a button that goes on to something after creating, the plain submit, and a line saying what each does. */
export interface NewProjectChoices {
  /** Shown first, as the main button. Its value goes to the action as `next`. */
  next: { label: string; value: "setup" | "audit" } | null;
  submitLabel: string;
  hint: string | null;
}

/** What the guided setup costs, in the hint's sentence. */
const SETUP_COST = rules.hasPlans ? "the few research credits it uses are included in your plan" : "its lookups cost a few cents of DataForSEO";

/**
 * Guided setup comes with a paid plan, and the action skips it on Free. On Free the site audit is the
 * one thing that can run, so the main button starts it, through Start crawl's op and gates. While
 * those gates refuse (`auditBlocked`, their message), it isn't offered and the line says why.
 */
export function newProjectChoices(free: boolean, auditPages: number, auditBlocked: string | null = null): NewProjectChoices {
  if (free && auditBlocked) return { next: null, submitLabel: "Create project", hint: `The site audit can't start yet. ${auditBlocked}` };
  if (free) {
    return {
      next: { label: "Create and audit", value: "audit" },
      submitLabel: "Just create it",
      hint: `Create and audit starts the site audit right away, up to ${formatNumber(auditPages)} pages, which is the Free plan's audit for this week. Site audit shows it as it runs. Just create it opens the project without starting anything.`,
    };
  }
  return {
    next: { label: "Create and suggest a setup", value: "setup" },
    submitLabel: "Just create it",
    hint: `Suggest a setup reads your homepage and public search data, then lists competitors, keywords and AI prompts for you to tick. It doesn't read your Search Console or Analytics. Nothing is added until you click Apply, and ${SETUP_COST}. Just create it opens an empty project you fill in yourself.`,
  };
}
