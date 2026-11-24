import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { Button, ButtonLink } from "@/components/ui/button";
import { Summary } from "@/components/ui/disclosure";
import { EmptyState } from "@/components/ui/empty-state";
import { Figure } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { docsHelpHref } from "@/components/ui/tab-href";
import { Section } from "@/components/ui/section";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import type { ActionResult } from "@/lib/action-result";
import { canSeeFixReports } from "@/lib/billing/gates";
import { rules } from "@/plan-policy/rules";
import { loadBillingWorkspace } from "@/lib/billing/workspace";
import { formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { dismissAction, markAppliedAction, reopenAction, verifyAction } from "@/modules/fixes/actions";
import { AgentPrompt } from "@/modules/fixes/agent-prompt";
import { APPLY_LABEL, FIX_TABS, fixesFigures, fixesSentence } from "@/modules/fixes/brief";
import { beforeLine, coversLine, fixDef, fixTitle, isManualCode, progressLine, proposedForPeople, shortCommit, type FixKind } from "@/modules/fixes/catalog";
import { CheckNowForm } from "@/modules/fixes/check-now-form";
import { LogChangeForm } from "@/modules/fixes/log-change-form";
import { coveredPairs, fixCounts, fixResultLines, listFixes, loggedChanges, openInCodeCount, type Fix } from "@/modules/fixes/queries";
import { latestResult, measuringLine, readStored, resultSentence, visitsMeaning, visitsSentence } from "@/modules/fixes/results";
import { refreshesPage, refreshHref } from "@/modules/fixes/refresh";
import { organicVisits, type CheckpointVisits, type VisitsSource } from "@/modules/fixes/visits";

export const metadata = { title: "Fixes" };

const TABS = FIX_TABS;

const KIND_LABEL: Record<FixKind, string> = { code: "In the code", content: "Needs writing", hosting: "Hosting" };

const STATUS_LABEL: Record<string, { label: string; tone: "neutral" | "good" | "warn" | "bad" }> = {
  open: { label: "To fix", tone: "neutral" },
  applied: { label: "Waiting to go live", tone: "warn" },
  live: { label: "Live", tone: "good" },
  measured: { label: "Measured", tone: "good" },
  resolved: { label: "Went away", tone: "good" },
  dismissed: { label: "Dismissed", tone: "neutral" },
};

function FixRow({ fix, projectId, reports, visits, visitsSource, covers, timeZone }: { fix: Fix; projectId: number; reports: boolean; visits?: Record<string, CheckpointVisits>; visitsSource: VisitsSource; covers?: string[]; timeZone: string }) {
  const status = STATUS_LABEL[fix.status] ?? STATUS_LABEL.open;
  const alsoCovers = coversLine(covers ?? []);
  const latest = reports ? latestResult(fix.results) : null;
  const latestVisits = latest ? visits?.[String(latest.days)] : undefined;
  const seen = progressLine(fix, timeZone);
  const measuring = measuringLine(fix);
  const manual = isManualCode(fix.code);
  return (
    <li className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{fixTitle(fix.code)}</span>
        {!manual && <Badge>{KIND_LABEL[fixDef(fix.code).kind]}</Badge>}
        {fix.status !== "open" && <Badge tone={status.tone}>{status.label}</Badge>}
      </div>
      <p className="max-w-[72ch] text-sm [overflow-wrap:anywhere] text-secondary">{beforeLine(fix)}</p>
      {alsoCovers && <p className="max-w-[72ch] text-xs [overflow-wrap:anywhere] text-muted">{alsoCovers}</p>}
      {fix.status === "open" && <p className="max-w-[72ch] text-xs text-muted">{proposedForPeople(fix.code, fix.url)}</p>}
      {seen && <p className="max-w-[72ch] text-xs [overflow-wrap:anywhere] text-muted">{seen}</p>}
      {measuring && <p className="max-w-[72ch] text-xs text-muted">{measuring}</p>}
      {latest && <p className="max-w-[72ch] text-sm">{resultSentence(readStored(latest), latest.days)}</p>}
      {latest && latestVisits && <p className="max-w-[72ch] text-sm text-secondary">{visitsSentence(latest, latestVisits, visitsSource)}</p>}
      {fix.appliedCommit && <p title={fix.appliedCommit} className="text-xs text-muted [overflow-wrap:anywhere]">Commit <span className="data">{shortCommit(fix.appliedCommit)}</span></p>}
      <div className="flex flex-wrap items-start gap-2">
        {fix.status === "open" && <RowAction action={markAppliedAction.bind(null, projectId)} id={fix.id} label={APPLY_LABEL} />}
        {(fix.status === "applied" || fix.status === "live") && <CheckNowForm action={verifyAction.bind(null, projectId)} id={fix.id} />}
        {(fix.status === "open" || fix.status === "applied") && <RowAction action={dismissAction.bind(null, projectId)} id={fix.id} label="Dismiss" quiet />}
        {fix.status === "dismissed" && !manual && <RowAction action={reopenAction.bind(null, projectId)} id={fix.id} label="Put back" />}
        {refreshesPage(fix.code) && (
          <ButtonLink href={refreshHref(fix.url)} size="sm" variant="ghost">
            Refresh this page
          </ButtonLink>
        )}
      </div>
    </li>
  );
}

function RowAction({ action, id, label, quiet }: { action: (form: FormData) => Promise<ActionResult>; id: number; label: string; quiet?: boolean }) {
  return (
    <ActionForm action={action}>
      <input type="hidden" name="id" value={id} />
      <Button type="submit" size="sm" variant={quiet ? "ghost" : "secondary"}>
        {label}
      </Button>
    </ActionForm>
  );
}

export default async function FixesPage({ searchParams }: PageProps<"/fixes">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const sp = await searchParams;
  const tab = TABS.find((t) => t.key === sp.status) ?? TABS[0];
  const scope = projectScope(project);
  // Logged changes have their own heading, so the tabs and their counts are the findings alone.
  const [counts, list, logged, billing, agentCanFix, timeZone] = await Promise.all([fixCounts(scope, { notSource: "manual" }), listFixes(scope, { status: tab.statuses, notSource: "manual" }, 100), loggedChanges(scope), loadBillingWorkspace(project.workspaceId), openInCodeCount(scope), currentTimeZone()]);
  const reports = canSeeFixReports(billing);
  const [[lines, visits], covers] = await Promise.all([reports ? Promise.all([fixResultLines(scope), organicVisits(scope, [...list.rows, ...logged.rows])]) : ([[], null] as const), coveredPairs(scope, list.rows.filter((f) => f.code === "duplicate-content").map((f) => f.url))]);
  const empty = !Object.values(counts).some(Boolean);
  const tabCount = (t: (typeof TABS)[number]) => t.statuses.reduce((n, s) => n + counts[s], 0);

  return (
    <>
      <PageHeader title="Fixes" description={`What's worth changing on ${project.domain}, and what the changes did.`} helpHref={docsHelpHref("/fixes")} />
      <Briefing sentence={fixesSentence(project.domain, counts, agentCanFix, lines[0]?.sentence ?? null)}>
        {fixesFigures(counts, agentCanFix).map((f) => (
          <Figure key={f.label} label={f.label} value={f.value} href={f.href} caption={f.caption} />
        ))}
      </Briefing>

      {empty ? (
        <div className="mt-8">
          <EmptyState title="Nothing on the list yet" description="Fixes come from a finished site audit and from Search Console's daily sync." action={<ButtonLink href="/audit#new-crawl">Start an audit</ButtonLink>} />
        </div>
      ) : (
        <>
          {counts.open > 0 && (
            <details open={counts.applied + counts.live + counts.measured === 0} className="group mt-8">
              <Summary className="w-fit text-sm font-medium underline-offset-4 hover:underline">Fix them with your agent</Summary>
              <div className="mt-3">
                <p className="mb-3 max-w-[72ch] text-sm text-secondary">
                  Connect Claude Code, Cursor or another coding agent with a key that can make changes on the{" "}
                  <Link href="/agents" className="underline underline-offset-4">
                    MCP page
                  </Link>
                  , then give it this from your site&apos;s repo.
                </p>
                <AgentPrompt prompt={`Use SEOpen's MCP tools to fix what's on the list for ${project.domain}. Call list_fixes for the ones of kind code, and get_fix for each before changing anything. Work on a seopen/fixes branch, make the smallest change that fixes it, run the build, and commit. Call mark_fix_applied with the commit. Once it's deployed, call verify_fix and tell me what it says.`} />
              </div>
            </details>
          )}

          {/* The newest line already opens the page. */}
          {lines.length > 1 && (
            <Section title="What else the fixes did">
              <ul className="flex flex-col gap-2 text-sm">
                {lines.slice(1, 9).map((l) => (
                  <li key={l.sentence}>{l.sentence}</li>
                ))}
              </ul>
            </Section>
          )}
          {!reports && (counts.applied + counts.live + counts.measured > 0 || logged.total > 0) && (
            <Section title="What the fixes did">
              <p className="mb-3 max-w-[72ch] text-sm text-secondary">Before and after reports at 7, 14 and 28 days are on the Starter plan and up. They&apos;re already being measured, so upgrading shows them straight away.</p>
              {rules.plansHref && (
                <ButtonLink href={rules.plansHref} size="sm">
                  See plans
                </ButtonLink>
              )}
            </Section>
          )}

          <Section title="The list">
            <SegmentedLinks label="Which fixes" options={TABS.map((t) => ({ href: t.key === "open" ? "/fixes" : `/fixes?status=${t.key}`, label: `${t.label} ${formatNumber(tabCount(t))}`, active: t.key === tab.key }))} />
            {list.rows.length ? (
              <ul className="mt-2 divide-y divide-line-soft">
                {list.rows.map((f) => (
                  <FixRow key={f.id} fix={f} projectId={project.id} reports={reports} visits={visits?.visits.get(f.id)} visitsSource={visits?.source ?? "plausible"} covers={covers.get(f.url)} timeZone={timeZone} />
                ))}
              </ul>
            ) : (
              <p className="mt-4 text-sm text-muted">Nothing here.</p>
            )}
            {!!visits?.visits.size && <p className="mt-3 max-w-[72ch] text-xs text-muted">{visitsMeaning(visits.source)}</p>}
            {list.total > list.rows.length && <p className="mt-3 text-xs text-muted">Showing the {formatNumber(list.rows.length)} that matter most, of {formatNumber(list.total)}.</p>}
          </Section>
        </>
      )}

      <Section title="Changes you logged" description="Changes made without a fix on the list, such as a title rewritten for a page people find in Search Console. Each is checked on the live page and measured like a fix.">
        {logged.rows.length ? (
          <ul className="divide-y divide-line-soft">
            {logged.rows.map((f) => (
              <FixRow key={f.id} fix={f} projectId={project.id} reports={reports} visits={visits?.visits.get(f.id)} visitsSource={visits?.source ?? "plausible"} timeZone={timeZone} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">None yet. Your agent logs them with record_change, or you can log one here.</p>
        )}
        {logged.total > logged.rows.length && <p className="mt-3 text-xs text-muted">Showing the newest {formatNumber(logged.rows.length)}, of {formatNumber(logged.total)}.</p>}
        <details className="group mt-4">
          <Summary className="w-fit text-sm font-medium underline-offset-4 hover:underline">Log a change</Summary>
          <div className="mt-3">
            <LogChangeForm projectId={project.id} domain={project.domain} />
          </div>
        </details>
      </Section>
    </>
  );
}
