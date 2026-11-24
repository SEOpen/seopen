import type { ComponentType } from "react";
import type { FigureData } from "@/components/ui/figure";
import type { workspaces } from "@/db/schema";
import type { BudgetExceededError, Refusal } from "./errors";
import type { BillingWorkspace, CountedLimit, GateResult, PlanLimits, ProjectRef } from "./limits";
import type { SpendWorkspace } from "./spend";
import type { GateWorkspace } from "./workspace";

/**
 * The seam between core and a hosted service's plans. Core keeps the spend safety every copy needs
 * (reservations, the platform cap, each workspace's cap, quotes, alerts, pauses, suspension) and asks
 * the plan policy everything else: a workspace's limits, how prices are shown, and what to say when
 * a plan refuses something.
 *
 * The policy is five files, imported as `@/plan-policy/rules`, `@/plan-policy/hooks`,
 * `@/plan-policy/ui`, `@/plan-policy/shell` and `@/plan-policy/admin`. They resolve to `src/lib/billing/plan-policy/` where that folder exists (a
 * hosted service's own plans) and to `src/lib/billing/self-hosted/` otherwise: no plans, no limits,
 * dollar prices and nothing to buy. next.config.ts and vitest.config.ts pick the file
 * (policy-file.ts); tsconfig.json lists both folders, first match wins, for types and for the worker.
 */

/** The fields a grant adds to a workspace row. */
export type GrantedWorkspace = { plan: string; grantedAt?: Date | null; grantEndsAt?: Date | null };

/** A plan feature a page shows in place of a form its plan doesn't include. */
export type PlanFeatureText = { title: string; description: string };

/** What Admin's grant form reads about a workspace. */
export interface GrantableWorkspace {
  id: number;
  name: string;
  plan: string;
  grantedAt: Date | null;
  subscriptionStatus: string | null;
}

/** Pure rules, safe in client components. */
export interface PlanRules {
  /** Whether this copy has plans at all. Core shows no plan wording, upsell or Billing page without them. */
  readonly hasPlans: boolean;
  /** Where a plan's upsell links, or null when there's nothing to buy. */
  readonly plansHref: string | null;
  /** What a new account starts on, said on the sign-up page, its waitlist note and the invite email, or null on a copy without plans. */
  newAccountLine(where: "sign-up" | "waitlist" | "invite"): string | null;
  /** A stored plan as Admin names it, such as "Starter". */
  planLabel(plan: string): string;
  /** What a workspace is, for Admin's sentence: "This workspace is <phrase> and has spent…". */
  planPhrase(plan: string): string;

  /** The workspace as its plan reads now, such as a dated grant that has ended. */
  withEndedGrant<T extends GrantedWorkspace>(ws: T, now?: Date): T;
  limitsFor(ws: BillingWorkspace): PlanLimits;
  isTrial(ws: BillingWorkspace): boolean;
  isFree(ws: BillingWorkspace): boolean;
  /** No customer limits: the operator's own workspace, and every workspace on a self-hosted copy. */
  isInternal(ws: BillingWorkspace): boolean;
  /** A failed charge the customer can still fix, or null. */
  paymentProblem(ws: BillingWorkspace & { billingError?: string | null }): string | null;
  canSeeFixReports(ws: BillingWorkspace): boolean;
  /** Whether pages show a check's DataForSEO dollar estimate. */
  showsDollarCosts(ws: BillingWorkspace): boolean;
  /** Whether an upgrade would raise `limit`, so a refusal can offer one. */
  upgradeRaises(ws: BillingWorkspace & { stripePriceId?: string | null }, limit: CountedLimit): boolean;

  canCreateProject(ws: BillingWorkspace, activeProjects: number): GateResult;
  canTrackKeywords(ws: BillingWorkspace, currentUnits: number, adding: number, depth: number): GateResult;
  canChangeDepth(ws: BillingWorkspace, otherUnits: number, projectKeywords: number, depth: number): GateResult;
  canAddPrompts(ws: BillingWorkspace, activePrompts: number, adding: number): GateResult;
  canStartManualAiRun(ws: BillingWorkspace, manualRunsThisWeek: number): GateResult;
  auditPageLimit(ws: BillingWorkspace, requested: number): number;
  auditJavascript(ws: BillingWorkspace, requested: boolean): boolean;
  gscRowsPerDay(ws: BillingWorkspace): number | null;
  /** The hard monthly dollar ceiling, from the plan and the workspace's own cap (`fallbackCapUsd` when it set none). */
  ceilingUsd(ws: BillingWorkspace, ownCapUsd: number | null, fallbackCapUsd: number): number;
  /** Projects past the limit after a downgrade, read-only until there's room again. */
  lockedProjectIds(ws: BillingWorkspace, projects: readonly ProjectRef[]): Set<number>;

  /** Dollars per research credit, for an allowance in credits. */
  readonly creditUsd: number;
  creditsFor(usd: number): number;
  creditsUsed(researchUsd: number): number;
  /** A Run button's price: "≈ 2 credits" on a hosted plan, "≈ $0.02" without plans. */
  costLabel(usd: number): string;
  /** A count of credits as a price, for a sentence: "2 research credits" ("2 credits" when `short`) on a hosted plan, "$0.02" without plans. */
  creditsText(credits: number, opts?: { short?: boolean }): string;
  /**
   * What research lookups spend, as a noun: "research credits" on a hosted plan, "DataForSEO spend" without plans. Only a
   * hosted plan's noun slots into "Uses …" or "Can spend …"; a sentence a copy without plans can show branches on `hasPlans`.
   */
  readonly researchNoun: string;
  /** The key and app scope that lets research lookups run, as its checkbox says it: "Can spend research credits" on a hosted plan, "Can run research lookups" without plans. */
  readonly researchScope: string;
  /** What MCP's `max_credits` counts, for a tool's description: "research credits" on a hosted plan, "cents" without plans. */
  readonly creditUnit: string;

  /** Refusals that hold whatever a call costs, after core's own suspension check. */
  stateRefusal(ws: SpendWorkspace, ownerVerified: boolean): Refusal | null;
  /** Whether `stateRefusal` needs to know the owner confirmed their email. */
  needsVerifiedOwner(ws: SpendWorkspace): boolean;
  /** Paid work the plan doesn't cover, or null. `module` is the spending module, when known. */
  paidWorkRefusal(ws: BillingWorkspace, module?: string): Refusal | null;
  /** The same refusal `paidWorkRefusal` gives, for a caller that already knows the plan refuses. */
  readonly notCoveredRefusal: Refusal;
  /** Refusal codes that are just how a plan works: a job stops on them without a pause banner. */
  readonly quietRefusalCodes: ReadonlySet<string>;
  readonly lockedRefusal: Refusal;
  lighthouseRefusal(ws: BillingWorkspace): Refusal | null;
  ceilingRefusal(ws: BillingWorkspace, ceilingUsd: number): Refusal;
  ceilingExceeded(ws: BillingWorkspace & { id: number }, spentUsd: number, ceilingUsd: number, estimateUsd: number): BudgetExceededError;
  creditsRefusal(ws: BillingWorkspace, creditsUsd: number): Refusal;
  manualRunCreditsRefusal(ws: BillingWorkspace, estimateUsd: number, leftUsd: number): Refusal;

  /** Whether the plan includes a dashboard module. */
  planIncludes(ws: BillingWorkspace, moduleId: string): boolean;
  /** What a page says in place of a module's form its plan doesn't include, or null for nothing. */
  planFeature(moduleId: string): PlanFeatureText | null;
  /** What an Overview figure says for a module the plan doesn't include. */
  readonly notIncludedLabel: string;
}

/** What core tells the plan when something happens that a plan may count. Server only. */
export interface PlanHooks {
  /** A project's site is about to be added or audited: a refusal when the plan won't allow it. */
  siteRefusal(workspaceId: number, domain: string, opts?: { dryRun?: boolean; doing?: "add" | "audit" }): Promise<Refusal | null>;
  /** The workspace's projects or their sites changed. Never throws. */
  sitesChanged(workspaceId: number): Promise<void>;
  /** A site, Google account or property was connected. Never throws. */
  connected(workspaceId: number, what: { domain?: string; googleAccount?: string; gscProperty?: string | null; ga4Property?: string | null }): Promise<void>;
  /** Paid work was refused. Never throws and never waits. */
  refused(workspaceId: number, refusal: Refusal): void;
  /** Why a site audit can't start now, beyond spend, or null. */
  auditRefusal(ws: GateWorkspace, projectId?: number): Promise<Refusal | null>;
  /** This month's allowance after anything spent earlier that still counts against it. */
  allowance(ws: SpendWorkspace, allowance: { ceilingUsd: number; creditsUsd: number }): Promise<{ ceilingUsd: number; creditsUsd: number }>;
  /** The plan a new workspace starts on. */
  newWorkspacePlan(by: "operator" | "signup"): string;
}

/** Components a hosted plan adds. Each renders nothing on a copy without plans. */
export interface PlanUi {
  /** Ends a trial now, from a refusal that an upgrade would lift. */
  UpgradeNow: ComponentType<{ size?: "sm" | "md"; className?: string; label?: string }>;
}

/** Server components the app shell mounts (`@/plan-policy/shell`). */
export interface PlanShell {
  /** Above every page: why paid work can't run or is paused, and anything a plan needs the customer to fix. */
  Banner: ComponentType;
  /** At the foot of the sidebar: this month's usage. */
  Meter: ComponentType;
  /** On Admin's page for one workspace: granting it a plan. */
  WorkspaceGrant: ComponentType<{ ws: GrantableWorkspace }>;
}

/** A daily count a plan adds to Admin's overview: a chart, a table column and a measure in its sentence. */
export interface AdminDailyMeasure {
  key: string;
  /** The chart's title and the column's head, such as "Upgrades". */
  label: string;
  /** One of them, for the sentence: "upgrade". */
  noun: string;
  /** Counts by UTC day ("2026-11-04"); a missing day is zero. */
  byDate: Record<string, number>;
}

/** What a plan adds to Admin → Overview. Core shows accounts, DataForSEO spend and Health without one. */
export interface AdminOverview {
  /** The page's description. */
  description: string;
  /** Figures after Accounts. */
  figures: FigureData[];
  /** Daily counts charted before New accounts. */
  daily: AdminDailyMeasure[];
  /** Ranked bars beside the spend meter, each step a share of the first, or null for none. */
  funnel: { title: string; description: string; steps: { label: string; n: number }[] } | null;
}

/** A workspace Health lists because it can't spend: a suspended one, and whatever else the plan stops. */
export interface StoppedWorkspace {
  workspaceId: number;
  workspace: string;
  plan: string;
  problem: string;
}

/** Health's list of workspaces that can't spend, and what Health and Overview call it. */
export interface AdminStopped {
  /** Overview's Health row. */
  label: string;
  /** Health's section. */
  title: string;
  description: string;
  filename: string;
  /** One of them, for Health's sentence. */
  noun: string;
  /** Health's figure that counts them with spend problems. */
  figure: string;
  rows: StoppedWorkspace[];
}

/** What a plan adds to Admin → Workspaces. */
export interface AdminWorkspaces {
  /** Figures after DataForSEO this month. */
  figures: { label: string; value: string; caption?: string }[];
  /** What the workspaces are on, for the sentence's list. Empty for none. */
  kinds: string[];
  /** Per workspace: what's said after its plan, the Claims column and its note. A workspace left out has none. */
  byId: Map<number, { status: string | null; claims: number; note: string }>;
}

/** What a plan adds to Admin's page for one workspace. */
export interface AdminWorkspace {
  /** The title of the section the plan is in. */
  title: string;
  /** Said after the plan's name, or null. */
  status: string | null;
  /** Facts after Plan and Created. */
  facts: [string, string][];
  /** Problems the plan has open, counted with the rest under Needs a look. */
  problems: number;
  /** Under Needs a look: what it counts. */
  problemsCaption: string;
}

/**
 * A plan's own figures in Admin (`@/plan-policy/admin`). Server only; the worker never loads it.
 * Without plans Admin shows accounts, workspaces, projects, spend and jobs, and nothing about money
 * coming in.
 */
export interface PlanAdmin {
  overview(days: number): Promise<AdminOverview>;
  /** Health's list of workspaces that can't spend. */
  stopped(): Promise<AdminStopped>;
  /** `rows` are every workspace. */
  workspaces(rows: readonly { id: number; plan: string }[], timeZone: string): Promise<AdminWorkspaces>;
  workspace(ws: typeof workspaces.$inferSelect, timeZone: string): Promise<AdminWorkspace>;
}
