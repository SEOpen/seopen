import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { PlanFeature } from "@/components/ui/plan-feature";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { ModuleTabs } from "@/components/ui/tabs";
import { creditsFor, isFree } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { getCurrentProject, normalizeDomain, type Project } from "@/lib/projects";
import { workspaceScope } from "@/lib/workspace/current";
import { DomainEmpty } from "@/modules/domains/components/domain-empty";
import { isHostname } from "@/modules/domains/transform";
import { RunPrompt } from "@/modules/keywords/components/research-ui";
import { costLabel } from "@/modules/keywords/format";
import { rules } from "@/plan-policy/rules";
import type { FetchMeta } from "./api";
import { loadPromptText } from "./brief";
import { filterHref } from "./logic";

export interface BacklinksTarget {
  project: Project | null;
  /** Domain under analysis, normalized. Null when there is no ?q= and no project, or when ?q= isn't a hostname. */
  target: string | null;
  /** The rejected ?q= input, when it isn't a hostname. Pages show BacklinksInvalid and make no API call. */
  invalid: string | null;
  /** True when the target is the current project's own domain. */
  isProjectDomain: boolean;
  /** The current workspace, for the DataForSEO calls. */
  workspaceId: number;
}

/** Target from ?q=, defaulting to the current project's domain. */
export async function resolveTarget(q: string | string[] | undefined): Promise<BacklinksTarget> {
  const [project, { workspaceId }] = await Promise.all([getCurrentProject(), workspaceScope()]);
  const raw = (Array.isArray(q) ? q[0] : q)?.trim();
  const normalized = raw ? normalizeDomain(raw) : (project?.domain ?? null);
  const invalid = raw && !isHostname(normalized ?? "") ? raw : null;
  const target = invalid ? null : normalized;
  return { project, target, invalid, isProjectDomain: !!project && target === project.domain, workspaceId };
}

/**
 * Why the current workspace can't spend, when the banner says so (suspended, no plan, unverified, trial
 * blocked), for a paid button's title. Undefined when it can.
 */
export async function spendRefusal(): Promise<string | undefined> {
  const { workspaceId } = await workspaceScope();
  return (await spendState(workspaceId)).refusal?.message;
}

/**
 * On the Free plan, which has no research credits: a page shows what Starter adds in place of a Run
 * (`RunNeeded` does it itself), hides its lookup forms, and reads only what's already saved.
 */
export async function onFreePlan(): Promise<boolean> {
  const { workspaceId } = await workspaceScope();
  return isFree((await spendState(workspaceId)).workspace);
}

const TABS = [
  { href: "/backlinks", label: "Overview" },
  { href: "/backlinks/referring-domains", label: "Referring domains" },
  { href: "/backlinks/links", label: "Links" },
  { href: "/backlinks/anchors", label: "Anchors" },
  { href: "/backlinks/gap", label: "Gap" },
  { href: "/backlinks/toxic", label: "Link review" },
];

/**
 * Page header, domain search box and tabs shared by every backlinks page. Look up only sets the domain; it
 * spends nothing. `loading`: this is a Suspense fallback, where the tabs can't go, because they read the
 * query. Their rule holds the place. `typed`: a rejected ?q=, kept in the box so it can be corrected.
 */
export function BacklinksHeader({ description, target, typed, actions, loading = false }: { description?: ReactNode; target: string | null; typed?: string; actions?: ReactNode; loading?: boolean }) {
  const q = target ? `?q=${encodeURIComponent(target)}` : "";
  return (
    <>
      <PageHeader
        title="Backlinks"
        description={description}
        actions={
          <>
            {actions}
            <form method="get" className="flex items-center gap-2">
              <Input name="q" defaultValue={typed ?? target ?? ""} placeholder="example.com" className="h-[38px] w-56" aria-label="Domain" />
              <Button type="submit" variant="secondary">
                Look up
              </Button>
            </form>
          </>
        }
      />
      {loading ? <div className="mb-5 h-[39px] shadow-[inset_0_-1px_0_var(--color-line)]" /> : <ModuleTabs tabs={TABS.map((t) => ({ ...t, href: `${t.href}${q}` }))} />}
    </>
  );
}

/** Every backlinks page when ?q= isn't a domain: says so, with the box to fix it and nothing to spend. */
export function BacklinksInvalid({ invalid }: { invalid: string }) {
  return (
    <>
      <BacklinksHeader target={null} typed={invalid} />
      <DomainEmpty invalid={invalid} title="Pick a domain" description="Enter a domain to see the links pointing to it." />
    </>
  );
}

/** Links that set one search param, keeping the others (e.g. All / New / Lost). The first option is the default. */
export function FilterPills({
  basePath,
  params,
  name,
  label,
  options,
}: {
  basePath: string;
  params: Record<string, string | undefined>;
  name: string;
  label: string;
  options: { value: string; label: string }[];
}) {
  const current = params[name] ?? options[0].value;
  return <SegmentedLinks label={label} options={options.map((o) => ({ href: filterHref(basePath, params, name, o.value, options[0].value), label: o.label, active: o.value === current }))} />;
}

/** First value of a search param. */
export function param(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Footnote saying what the data cost: research credits on a hosted plan, never dollars; dollars without plans. */
export function CostNote({ metas, ttl }: { metas: FetchMeta[]; ttl: string }) {
  const spent = metas.reduce((n, m) => n + m.costUsd, 0);
  const estimate = metas.reduce((n, m) => n + m.estimateUsd, 0);
  const allCached = metas.every((m) => m.cached);
  return (
    <p className="mt-3 text-xs text-muted">
      {allCached ? "Loaded from saved data, no charge" : `Fetched now for ${rules.creditsText(creditsFor(spent), { short: true })}`}. A fresh load costs {costLabel(estimate)}, and is kept for {ttl}.
    </p>
  );
}

/** True when the URL asks to spend (?run=1) and SEOpen's own page sent it. Only Run buttons that show the cost add it. */
export { wantsRun } from "@/lib/run-request";

/** The same page with run=1 added: the target of a Run button. */
export function runHref(basePath: string, params: Record<string, string | undefined>): string {
  const next = new URLSearchParams(Object.entries({ ...params, run: "1" }).filter((e): e is [string, string] => !!e[1]));
  return `${basePath}?${next}`;
}

/**
 * Shown in place of a section whose data isn't cached; nothing is spent until the button is clicked. With
 * nothing else on the page, it's the page's one job. With stored numbers already showing, `missing` names
 * what they don't cover, and it stays secondary and asks in place. While the workspace can't spend, the
 * button is off and carries the reason the banner gives. On Free it's what Starter adds instead, as on the
 * overview, since a lookup would only be refused.
 */
export async function RunNeeded({
  what,
  target,
  costUsd,
  basePath,
  params,
  ttl,
  missing,
}: {
  what: string;
  target: string;
  costUsd: number;
  basePath: string;
  params: Record<string, string | undefined>;
  ttl: string;
  missing?: string;
}) {
  if (await onFreePlan()) return <PlanFeature module="backlinks" />;
  const refused = await spendRefusal();
  const { title, description } = loadPromptText(what, target, ttl, missing);
  if (!missing) return <RunPrompt title={title} description={description} href={runHref(basePath, params)} costUsd={costUsd} refused={refused} />;
  const hidden = Object.entries({ ...params, run: "1" }).filter((e): e is [string, string] => !!e[1]);
  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-[1_1_20rem]">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 max-w-[69ch] text-sm text-muted">{description}</p>
      </div>
      {/* A GET form, so nothing can prefetch the paid call. */}
      <form method="get" action={basePath}>
        {hidden.map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <SpendConfirm question={`Run ${what.charAt(0).toLowerCase()}${what.slice(1)} (${costLabel(costUsd)})?`} confirmLabel="Run" disabled={!!refused} title={refused}>
          Run ({costLabel(costUsd)})
        </SpendConfirm>
      </form>
    </div>
  );
}
