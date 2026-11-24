import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { PlanFeature, PlanFeatureCard } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { creditsFor, isFree, isInternal, showsDollarCosts } from "@/lib/billing/gates";
import { checkGate } from "@/lib/billing/check-gate";
import { spendBlock, spendState } from "@/lib/billing/spend";
import { plainAiFailure } from "@/lib/dataforseo/failure-copy";
import { formatShortDate } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { promptsDescription, promptsFigures, promptsSentence } from "@/modules/ai/brief";
import { AddPrompts } from "@/modules/ai/components/add-prompts";
import { AiTabs, RunStatus } from "@/modules/ai/components/chrome";
import { PromptTable, type PromptTableRow } from "@/modules/ai/components/prompt-table";
import { RunButton } from "@/modules/ai/components/run-controls";
import { activeRun, getPromptTable } from "@/modules/ai/data";
import { namesBrand } from "@/modules/ai/detect";
import { LLM_MENTIONS_COST_USD, RUNS_PER_MONTH } from "@/modules/ai/platforms";
import { monthlyCost } from "@/modules/ai/prompts";
import { costRates, estimateRun, loadBrands } from "@/modules/ai/run";

export const metadata = { title: "AI prompts" };

export default async function AiPromptsPage() {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const [ws, gate, spend, researchBlock, table, rates, estimate, running, brands, timeZone] = await Promise.all([
    currentWorkspace(),
    checkGate(project.workspaceId),
    spendState(project.workspaceId),
    spendBlock(project.workspaceId, { research: true }),
    getPromptTable(projectScope(project)),
    costRates(project.workspaceId),
    estimateRun(project),
    activeRun(projectScope(project)),
    loadBrands(project),
    currentTimeZone(),
  ]);
  const active = table.filter((r) => r.prompt.active).map((r) => r.prompt);
  // The plan policy says whether this workspace sees dollar estimates: every one on a copy without plans.
  const showCost = showsDollarCosts(ws);
  // The weekly LLM Mentions task is a fixed cost per project with any active prompt.
  const mentionsMonthly = LLM_MENTIONS_COST_USD * RUNS_PER_MONTH;
  const currentMonthly = monthlyCost(active, rates) + (active.length ? mentionsMonthly : 0);

  const rows: PromptTableRow[] = table.map(({ prompt, results, aio }) => {
    const cells = Object.fromEntries(
      Object.entries(results).map(([k, v]) => [k, v && { status: v.status, mentioned: v.mentioned, cited: v.cited, position: v.position, error: v.status !== "failed" ? null : isInternal(ws) && v.error ? v.error : plainAiFailure(v.error) }]),
    );
    const done = prompt.platforms.map((p) => results[p]).filter((r) => r?.status === "done");
    return {
      id: prompt.id,
      prompt: prompt.prompt,
      keyword: prompt.keyword,
      topic: prompt.topic,
      branded: namesBrand(prompt.prompt, brands[0]),
      active: prompt.active,
      platforms: prompt.platforms,
      results: cells,
      aio: aio && { present: aio.present, cited: aio.cited, day: formatShortDate(aio.createdAt, timeZone) },
      mentionedOn: done.filter((r) => r?.mentioned).length,
      citedOn: done.filter((r) => r?.cited).length,
      checkedOn: done.length,
    };
  });

  const free = isFree(ws);
  const addPrompts = free ? (
    <div className="mt-8 max-w-2xl">
      <PlanFeatureCard title="Add prompts" module="ai" />
    </div>
  ) : (
    <Card className={rows.length ? "mt-8" : "mt-6"}>
      <CardHeader
        title="Add prompts"
        description={showCost ? "Questions are asked weekly. The cost estimate uses the average cost of past answers per platform." : "Questions are asked weekly on each platform you pick."}
      />
      <CardBody>
        <AddPrompts
          projectId={project.id}
          // Costs are internal, so a customer's browser doesn't get them even unshown.
          rates={showCost ? rates : { perAnswer: {}, aio: 0 }}
          currentMonthly={showCost ? currentMonthly : 0}
          fixedMonthly={showCost && !active.length ? mentionsMonthly : 0}
          ownDomains={brands[0].domains}
          topics={[...new Set(table.map((r) => r.prompt.topic).filter((t): t is string => !!t))].sort((a, b) => a.localeCompare(b))}
          showCost={showCost}
          // Suggest prompts spends research credits, so it's off when they or the ceiling run out.
          suggestRefused={(spend.refusal ?? researchBlock)?.message ?? null}
        />
      </CardBody>
    </Card>
  );

  return (
    <>
      <PageHeader
        title="AI visibility"
        description={free && !rows.length ? "The questions AI visibility asks each week." : promptsDescription(active.length, { free, monthlyUsd: showCost ? currentMonthly : null })}
        actions={
          // Free with nothing tracked has nothing to run, so it's offered none.
          free && !rows.length ? undefined : (
            <RunButton
              projectId={project.id}
              estimateUsd={showCost ? estimate.usd : null}
              credits={creditsFor(estimate.usd)}
              answers={estimate.answers}
              disabled={!!running}
              // The plan's refusal first: Free has no spend banner, but it asks no AI questions either.
              // Then research credits, which a run started by hand uses.
              refused={(gate("ai", project.id) ?? spend.refusal ?? researchBlock)?.message}
              first={!rows.some((r) => r.checkedOn > 0)}
            />
          )
        }
      />
      <AiTabs />
      <RunStatus scope={projectScope(project)} canRun={active.length > 0} />

      {rows.length ? (
        <>
          <Briefing sentence={promptsSentence(rows)}>
            {promptsFigures(rows).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          <Section title="Tracked prompts" className="mt-6">
            <PromptTable projectId={project.id} rows={rows} />
            <p className="mt-2 max-w-[76ch] text-xs text-muted">
              A tick means your brand is named in the latest answer, and #2 means it was named second among tracked brands. “Cited” means a source in the answer links to your site. “Branded” means the
              prompt itself names your brand, and Overview leaves those out by default. Select prompts to set their topic or delete them.
            </p>
          </Section>
          {addPrompts}
        </>
      ) : free ? (
        <PlanFeature module="ai" />
      ) : (
        <>
          <EmptyState title="No tracked prompts yet" description="Add the questions your customers ask an AI assistant, or let SEOpen suggest some from your keywords." />
          {addPrompts}
        </>
      )}
    </>
  );
}
