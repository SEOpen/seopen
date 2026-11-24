import { Suspense } from "react";
import { ApiError } from "@/components/api-error";
import { Briefing } from "@/components/ui/briefing";
import { Callout } from "@/components/ui/callout";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { PageSkeleton } from "@/components/ui/page-skeleton";
import { Section } from "@/components/ui/section";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { ModuleTabs } from "@/components/ui/tabs";
import { isFree } from "@/lib/billing/gates";
import { spendState } from "@/lib/billing/spend";
import { locationName } from "@/lib/dataforseo/locations";
import { formatNumber } from "@/lib/format";
import { getCurrentProject, type Project } from "@/lib/projects";
import { wantsRun } from "@/lib/run-request";
import { projectScope } from "@/lib/workspace";
import { workspaceScope } from "@/lib/workspace/current";
import { ideasFigures, ideasSentence } from "@/modules/keywords/brief";
import { load, peek, settle } from "@/modules/keywords/dfs";
import { IdeasExplorer } from "@/modules/keywords/components/ideas-explorer";
import type { GridColumn } from "@/modules/keywords/components/keyword-grid";
import { KeywordsPlanFeature } from "@/modules/keywords/components/plan-note";
import { CountryDataNote, FetchedNote, ResearchForm, RunPrompt } from "@/modules/keywords/components/research-ui";
import { costLabel } from "@/modules/keywords/format";
import { listOptions, listSummaries } from "@/modules/keywords/lists";
import { href, keywordQuery, keywordTabs, param, resolveMarket } from "@/modules/keywords/market";
import { IDEA_MODES, MAX_KEYWORD_LENGTH, type IdeaMode, type Market } from "@/modules/keywords/requests";
import { columnsWithData, relatedRows, toKeywordRow, type KeywordRow } from "@/modules/keywords/transform";
import type { RelatedResult, SuggestionsResult } from "@/modules/keywords/types";

export const metadata = { title: "Keyword ideas" };

const COLUMNS: GridColumn[] = [
  { key: "keyword", label: "Keyword", format: "keyword" },
  { key: "intent", label: "Intent", format: "intent" },
  { key: "volume", label: "Volume", format: "number" },
  { key: "kd", label: "Difficulty", format: "kd" },
  { key: "cpc", label: "Cost per click", format: "usd" },
  { key: "competition", label: "Competition", format: "pct" },
  { key: "words", label: "Words", format: "number" },
];

export default async function IdeasPage({ searchParams }: PageProps<"/keywords/ideas">) {
  const sp = await searchParams;
  const { q, tooLong } = keywordQuery(param(sp.q));
  const rawMode = param(sp.mode);
  const mode: IdeaMode = rawMode && rawMode in IDEA_MODES ? (rawMode as IdeaMode) : "suggestions";
  const [project, { workspaceId }] = await Promise.all([getCurrentProject(), workspaceScope()]);
  const { refusal, workspace } = await spendState(workspaceId);
  const free = isFree(workspace);
  // Free never asks to spend, so a run=1 address only reads what's already saved.
  const run = !free && (await wantsRun(sp.run));
  const m = resolveMarket(param(sp.loc), project);
  const spec = IDEA_MODES[mode].spec(q || "x", m);
  const hits = q ? await Promise.all((Object.keys(IDEA_MODES) as IdeaMode[]).map(async (k) => [k, !!(await peek(IDEA_MODES[k].spec(q, m), workspaceId))] as const)) : [];
  const cachedModes = new Set(hits.filter(([, hit]) => hit).map(([k]) => k));
  const cost = q && cachedModes.has(mode) ? 0 : spec.estUsd;
  const header = (
    <>
      <PageHeader title="Keyword research" description={`Suggestions, related searches and questions around a seed keyword · ${locationName(m.locationCode)}`} />
      <ModuleTabs tabs={keywordTabs(q, m.locationCode)} />
    </>
  );
  // Free has no research credits, so it's told what Starter adds instead of offered a lookup it would refuse.
  // An idea list that's already saved costs nothing, so it still shows.
  if (free && (tooLong || !q || cost > 0)) {
    const saved = project && !q && !tooLong ? await listSummaries(projectScope(project)) : [];
    return (
      <>
        {header}
        <KeywordsPlanFeature hasLists={saved.length > 0} locationCode={m.locationCode} />
      </>
    );
  }

  return (
    <>
      {header}
      {!free && (
        <div className="mb-4">
          <ResearchForm action="/keywords/ideas" q={q} placeholder="Seed keyword" locationCode={m.locationCode} costUsd={cost} freshUsd={spec.estUsd} hidden={{ mode }} label="Find ideas" quiet={!!q} refused={refusal?.message} />
        </div>
      )}
      <CountryDataNote project={project} locationCode={m.locationCode} what="Ideas and their volumes are for" />
      {tooLong ? (
        <EmptyState title="That keyword is too long" description={`Keywords can be up to ${formatNumber(MAX_KEYWORD_LENGTH)} characters, so nothing was looked up.`} />
      ) : !q ? (
        <EmptyState title="Start from a seed keyword" description="Ideas come back with volume, difficulty, cost per click and intent. Filtering and grouping them is free." />
      ) : (
        <>
          {/* Only the row scrolls when the costs don't fit a narrow screen. None of these links carries run=1. */}
          <div className="mb-4 overflow-x-auto [scrollbar-width:none]">
            <SegmentedLinks
              label="Kind of idea"
              options={(Object.keys(IDEA_MODES) as IdeaMode[]).map((k) => ({
                href: href("/keywords/ideas", { q, loc: m.locationCode, mode: k }),
                label: `${IDEA_MODES[k].label} · ${cachedModes.has(k) ? "loaded" : free ? "not loaded" : costLabel(IDEA_MODES[k].spec(q, m).estUsd)}`,
                active: k === mode,
              }))}
            />
          </div>
          {cost > 0 && !run ? (
            <RunPrompt
              title={`${IDEA_MODES[mode].label} for “${q}” aren't loaded yet`}
              description={`${IDEA_MODES[mode].help}. Up to 500 ideas, kept for 30 days. You pay per idea returned, so the real cost is often lower.`}
              href={href("/keywords/ideas", { q, loc: m.locationCode, mode, run: 1 })}
              costUsd={cost}
              refused={refusal?.message}
            />
          ) : (
            <Suspense fallback={<PageSkeleton header={false} label="Loading ideas" />}>
              <Ideas q={q} m={m} mode={mode} run={run} project={project} />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}

/** Loads one idea list as rows. Returns null when it isn't cached and the page wasn't asked to spend. */
async function loadIdeas(q: string, m: Market, mode: IdeaMode, run: boolean, workspaceId: number, projectId: number | undefined) {
  if (mode === "related") {
    const data = await load<RelatedResult>(IDEA_MODES.related.spec(q, m), { run, workspaceId, projectId });
    if (data.state === "idle") return null;
    const rows = relatedRows(data.results[0]?.items).filter((r) => r.keyword !== q);
    return { rows, total: data.results[0]?.total_count ?? rows.length, fetchedAt: data.fetchedAt, cached: data.cached };
  }
  const data = await load<SuggestionsResult>(IDEA_MODES[mode].spec(q, m), { run, workspaceId, projectId });
  if (data.state === "idle") return null;
  const rows: KeywordRow[] = (data.results[0]?.items ?? []).map(toKeywordRow).filter((r) => r.keyword !== q);
  return { rows, total: data.results[0]?.total_count ?? rows.length, fetchedAt: data.fetchedAt, cached: data.cached };
}

async function Ideas({ q, m, mode, run, project }: { q: string; m: Market; mode: IdeaMode; run: boolean; project: Project | null }) {
  const { workspaceId } = await workspaceScope();
  const loaded = await settle(() => loadIdeas(q, m, mode, run, workspaceId, project?.id));
  if (!loaded.ok) return <ApiError error={loaded.error} />;
  if (!loaded.value) return null;
  const { rows, total, fetchedAt, cached } = loaded.value;
  if (!rows.length) return <EmptyState title="No ideas found" description="Try a shorter or broader seed keyword." />;
  const lists = project ? await listOptions(projectScope(project)) : null;

  return (
    <>
      {!project && (
        <div className="mb-4">
          <Callout title="Saving needs a project">Keyword lists belong to a project. You can still copy or export ideas.</Callout>
        </div>
      )}
      <Briefing sentence={ideasSentence({ seed: q, kind: mode, rows })}>
        {ideasFigures({ rows, total }).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>
      <Section
        title={IDEA_MODES[mode].label}
        description={
          <>
            {IDEA_MODES[mode].help} · {locationName(m.locationCode)} · <FetchedNote fetchedAt={fetchedAt} cached={cached} />
          </>
        }
        className="mt-6"
      >
        <IdeasExplorer rows={rows} seed={q} columns={columnsWithData(COLUMNS, rows)} lists={lists} market={m} source={`ideas:${mode}:${q}`} filename={`ideas-${mode}-${q.replace(/\s+/g, "-")}`} />
      </Section>
    </>
  );
}
