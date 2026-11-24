import type { BillingWorkspace } from "@/lib/billing/gates";
import { getPlausibleConnectionInfo, fixtureMode as plausibleFixtures } from "@/modules/plausible/account";
import { plausibleOpen } from "@/modules/plausible/gate";
import { listPlausibleSites } from "@/modules/plausible/sites";
import { getPosthogAccount, fixtureMode as posthogFixtures } from "@/modules/posthog/account";
import { oauthAvailable } from "@/modules/posthog/oauth";
import { listPosthogProjects } from "@/modules/posthog/projects";
import { fixtureMode as umamiFixtures, getUmamiConnectionInfo } from "@/modules/umami/account";
import { umamiOpen } from "@/modules/umami/gate";
import { listUmamiSites } from "@/modules/umami/sites";
import type { PlausibleChoice, PosthogChoice, UmamiChoice } from "./match";

/** One source's offer on the new project form: its list, a pointer to connect it, or nothing. */
export type SourceChoice<T> = { state: "connected"; items: T[] } | { state: "connect" } | { state: "hidden" };

export interface OtherSourceChoices {
  posthog: SourceChoice<PosthogChoice>;
  plausible: SourceChoice<PlausibleChoice>;
  umami: SourceChoice<UmamiChoice>;
}

/**
 * PostHog, Plausible and Umami for the new project form, beside `googleChoices`. It never rejects: the
 * page streams it past the form, and a failure at any must not get in the way of creating a project.
 * PostHog is hidden where OAuth can't run (no https origin), Plausible and Umami where they aren't open yet.
 */
export async function otherSourceChoices(workspaceId: number, ws: BillingWorkspace): Promise<OtherSourceChoices> {
  const [posthog, plausible, umami] = await Promise.all([
    posthogChoice(workspaceId),
    plausibleOpen(ws) ? plausibleChoice(workspaceId) : ({ state: "hidden" } as const),
    umamiOpen(ws) ? umamiChoice(workspaceId) : ({ state: "hidden" } as const),
  ]);
  return { posthog, plausible, umami };
}

async function posthogChoice(workspaceId: number): Promise<SourceChoice<PosthogChoice>> {
  try {
    if (!posthogFixtures()) {
      const account = await getPosthogAccount(workspaceId);
      if (!account) return oauthAvailable() ? { state: "connect" } : { state: "hidden" };
      if (account.status === "reauth_required") return { state: "connect" };
    }
    const projects = await listPosthogProjects(workspaceId);
    return { state: "connected", items: projects.map((p) => ({ id: String(p.id), name: p.name })) };
  } catch (e) {
    console.error("[posthog.choices]", e);
    return { state: "hidden" };
  }
}

async function plausibleChoice(workspaceId: number): Promise<SourceChoice<PlausibleChoice>> {
  try {
    if (!plausibleFixtures()) {
      const account = await getPlausibleConnectionInfo(workspaceId);
      if (!account || account.status === "reauth_required") return { state: "connect" };
    }
    const sites = await listPlausibleSites(workspaceId);
    return { state: "connected", items: sites.map((s) => ({ domain: s.domain })) };
  } catch (e) {
    console.error("[plausible.choices]", e);
    return { state: "hidden" };
  }
}

async function umamiChoice(workspaceId: number): Promise<SourceChoice<UmamiChoice>> {
  try {
    if (!umamiFixtures()) {
      const account = await getUmamiConnectionInfo(workspaceId);
      if (!account || account.status === "reauth_required") return { state: "connect" };
    }
    const sites = await listUmamiSites(workspaceId);
    return { state: "connected", items: sites.map((s) => ({ id: s.id, name: s.name, domain: s.domain })) };
  } catch (e) {
    console.error("[umami.choices]", e);
    return { state: "hidden" };
  }
}
