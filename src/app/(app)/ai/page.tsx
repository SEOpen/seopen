import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Delta } from "@/components/ui/delta";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureStrip, FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { PlanFeature } from "@/components/ui/plan-feature";
import { Section } from "@/components/ui/section";
import { creditsFor, isFree, showsDollarCosts } from "@/lib/billing/gates";
import { changeDelta } from "@/lib/brief";
import { checkGate } from "@/lib/billing/check-gate";
import { spendBlock, spendState } from "@/lib/billing/spend";
import { CheckFailureCallout } from "@/components/ui/check-failure-callout";
import { checkIsMainAction, failureAgain, failureLink, lastTry, pageFailure, type CheckFailure } from "@/lib/check-failure";
import { formatDate, formatDateTimeZoned, formatNumber, formatPct, formatShortDate, formatUsd } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { mondayJobTime } from "@/lib/schedule";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { aioCoverage, aioSource, aiFigures, aiSentence, platformCount, trendChart } from "@/modules/ai/brief";
import { AiTabs, Bar, RunStatus } from "@/modules/ai/components/chrome";
import { RunButton } from "@/modules/ai/components/run-controls";
import { VisibilityTrend } from "@/modules/ai/components/visibility-trend";
import { setIncludeBranded } from "@/modules/ai/actions";
import { activeRun, getAioSummary, getLlmMentions, getOverview, listPrompts, listRuns, mentionsFailure } from "@/modules/ai/data";
import { aiFailure, aioFailure, aiRunLabel, mentionsCheckFailure } from "@/modules/ai/failure";
import { withFailedPlatforms } from "@/modules/ai/metrics";
import { LLM_MENTIONS_COST_USD, PLATFORM_KEYS, PLATFORMS, platformLabel } from "@/modules/ai/platforms";
import { estimateRun } from "@/modules/ai/run";

export const metadata = { title: "AI visibility" };

const ASSISTANTS = new Intl.ListFormat("en-US", { type: "conjunction" }).format(PLATFORMS.map((p) => p.label));

export default async function AiOverviewPage() {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const [ws, gate, spend, researchBlock, timeZone, prompts, overview, aio, mentions, mentionsFailed, estimate, running, [newest]] = await Promise.all([
    currentWorkspace(),
    checkGate(project.workspaceId),
    spendState(project.workspaceId),
    spendBlock(project.workspaceId, { research: true }),
    currentTimeZone(),
    listPrompts(projectScope(project)),
    getOverview(project),
    getAioSummary(projectScope(project)),
    getLlmMentions(projectScope(project)),
    mentionsFailure(projectScope(project)),
    estimateRun(project),
    activeRun(projectScope(project)),
    listRuns(projectScope(project), 1),
  ]);
  const failure = !running && newest ? pageFailure(aiFailure({ status: newest.status, error: newest.error, createdAt: newest.startedAt }, timeZone), gate("ai", project.id)) : null;
  // The weekly checks a run makes beside its answers can fail on their own, leaving older numbers below.
  const aioFailed = !running && aio.failed ? pageFailure(aioFailure(aio.failed, timeZone), gate("ai", project.id)) : null;
  const mentionsFailedCheck = !running && mentionsFailed ? pageFailure(mentionsCheckFailure(mentionsFailed, timeZone), gate("ai", project.id)) : null;
  // The plan policy says whether this workspace sees dollar estimates: every one on a copy without plans.
  const showCost = showsDollarCosts(ws);
  // Free asks no AI questions: with nothing tracked, the page says what Starter adds and offers no run.
  const onStarter = isFree(ws) && !prompts.length;
  const { current, previousByPlatform, failedByPlatform, sov, brands, promptCounts, includesBranded, lastRunAt } = overview;
  const nameOf = (domain: string) => brands.find((b) => b.domain === domain)?.name ?? domain;
  const { days } = mondayJobTime("07:00", timeZone);
  const shares = [...sov].sort((a, b) => b.answers - a.answers || Number(b.own) - Number(a.own));
  const silent = shares.filter((s) => !s.answers && !s.cited && !s.own);
  const chart = trendChart(overview);
  const byPlatform = withFailedPlatforms(overview.byPlatform, failedByPlatform, PLATFORM_KEYS);

  return (
    <>
      <PageHeader
        title="AI visibility"
        description={`How often ${ASSISTANTS} name ${project.name} when asked your tracked questions.${onStarter ? "" : ` ${aiRunLabel(lastRunAt ? formatDateTimeZoned(lastRunAt, timeZone) : null, failure)}, asked weekly on ${days}.`}`}
        actions={
          onStarter ? undefined : (
            <RunButton
              projectId={project.id}
              estimateUsd={showCost ? estimate.usd : null}
              credits={creditsFor(estimate.usd)}
              answers={estimate.answers}
              disabled={!!running}
              // The plan's refusal first: Free has no spend banner, but it asks no AI questions either.
              // Then research credits, which a run started by hand uses.
              refused={(gate("ai", project.id) ?? spend.refusal ?? researchBlock)?.message}
              first={checkIsMainAction(current.total > 0, failure)}
            />
          )
        }
      />
      <AiTabs />
      <RunStatus scope={projectScope(project)} canRun={prompts.some((p) => p.active)} answersAt={lastRunAt} />

      {onStarter ? (
        <PlanFeature module="ai" />
      ) : !prompts.length ? (
        <EmptyState
          title="No tracked prompts yet"
          description="Add the questions your customers ask an AI assistant, or let SEOpen suggest some from your keywords. Each is asked weekly on ChatGPT, Perplexity, Gemini and Claude."
          action={<ButtonLink href="/ai/prompts">Add prompts</ButtonLink>}
        />
      ) : !current.total ? (
        <EmptyState
          title="No answers yet"
          description={
            failure
              ? `The last run failed, so there's nothing to show yet.${failure.retry ? " Run now tries again." : ""}`
              : `${prompts.length} prompt${prompts.length === 1 ? " is" : "s are"} tracked. Results appear after the first run (weekly on ${days}, or Run now).`
          }
        />
      ) : (
        <>
          <BrandedNote projectId={project.id} counts={promptCounts} includesBranded={includesBranded} />
          <Briefing sentence={aiSentence(overview)}>
            {aiFigures(overview, `/projects/${project.id}/settings`).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>

          <div className="grid gap-x-10 @3xl/main:grid-cols-2">
            <Section title="Visibility by platform" description="Share of prompts whose latest answer mentions you">
              <ul className="grid gap-4">
                {byPlatform.map((p) => {
                  const prev = previousByPlatform.find((x) => x.platform === p.platform);
                  const delta = p.score != null && prev?.score != null ? changeDelta(p.score - prev.score, "points", "up") : null;
                  return (
                    <li key={p.platform} className="grid gap-1.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className="mr-auto">{platformLabel(p.platform)}</span>
                        <span className="text-xs text-muted">{platformCount(p, failedByPlatform[p.platform])}</span>
                        {delta && delta.tone !== "muted" && <Delta {...delta} />}
                        {p.total > 0 && <span className="data text-fg">{formatPct(p.score)}</span>}
                      </div>
                      {p.total > 0 && <Bar value={p.score} track />}
                    </li>
                  );
                })}
              </ul>
            </Section>

            <Section title="Share of voice" description="Answers naming each brand, as a share of all tracked brands' mentions">
              <ul className="grid gap-4">
                {shares
                  .filter((s) => !silent.includes(s))
                  .map((s) => (
                    <li key={s.domain} className="grid gap-1.5">
                      <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                        <span className={s.own ? "font-medium [overflow-wrap:anywhere]" : "[overflow-wrap:anywhere]"} title={s.domain}>
                          {nameOf(s.domain)}
                        </span>
                        <span className="mr-auto text-xs text-muted">
                          named in {formatNumber(s.answers)}, cited in {formatNumber(s.cited)}
                        </span>
                        <span className="data text-fg">{formatPct(s.sov)}</span>
                      </div>
                      <Bar value={s.sov} tone={s.own ? "strong" : "neutral"} />
                    </li>
                  ))}
              </ul>
              {silent.length > 0 && (
                <p className="mt-4 text-xs text-muted">
                  {silent.length} more at 0%: {silent.map((s) => nameOf(s.domain)).join(", ")}.
                </p>
              )}
            </Section>
          </div>

          {promptCounts.branded > 0 && promptCounts.nonBranded > 0 && (
            <Section
              title="Branded and generic prompts"
              description={`Counted apart, whatever the setting above: a branded question names your brand, so its answers name you almost by definition and can hide how rarely AI recommends you unprompted. AI visibility run, ${lastRunAt ? formatDate(lastRunAt, timeZone) : "not run yet"}.`}
            >
              <ul className="grid gap-4">
                {(
                  [
                    ["Generic", promptCounts.nonBranded, overview.groups.generic],
                    ["Branded", promptCounts.branded, overview.groups.branded],
                  ] as const
                ).map(([label, n, v]) => (
                  <li key={label} className="grid gap-1.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="mr-auto">
                        {label} <span className="text-xs text-muted">({formatNumber(n)} prompt{n === 1 ? "" : "s"})</span>
                      </span>
                      <span className="text-xs text-muted">
                        named in {formatNumber(v.mentioned)} of {formatNumber(v.total)} answers, cited in {formatNumber(v.cited)}
                      </span>
                      {v.total > 0 && <span className="data text-fg">{formatPct(v.score)}</span>}
                    </div>
                    {v.total > 0 && <Bar value={v.score} track />}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section
            title="Trend"
            description={`After each run: your visibility and each competitor's mention rate, as a % of the answers that came back.${chart.neverNamed ? ` ${chart.neverNamed} ${chart.neverNamed === 1 ? "competitor" : "competitors"} never named ${chart.neverNamed === 1 ? "isn't" : "aren't"} drawn.` : ""}`}
          >
            <VisibilityTrend rows={chart.rows} series={chart.series} />
          </Section>
        </>
      )}

      {prompts.length > 0 && (
        <>
          <Section title="Google AI Overviews" description={aioSource(project)}>
            <WeeklyCheckFailed failure={aioFailed} from={aio.lastAt} timeZone={timeZone} />
            {aio.checked ? (
              <>
                <FigureStrip label="Google AI Overviews">
                  <FigureView small data={{ id: "present", state: "value", label: "Show an AI Overview", value: `${formatNumber(aio.present)} of ${formatNumber(aio.checked)}`, delta: null, caption: "keywords checked" }} />
                  <FigureView small data={{ id: "cited", state: "value", label: "Cite you", value: formatNumber(aio.cited), delta: null, caption: "keywords where it links to you" }} />
                  <FigureView small data={{ id: "named", state: "value", label: "Name you", value: formatNumber(aio.mentioned), delta: null, caption: "keywords where it mentions you" }} />
                </FigureStrip>
                <p className="mt-2 text-xs text-muted">
                  Last checked {formatDate(aio.lastAt, timeZone)}. {aioCoverage(aio.checked, prompts.filter((p) => p.active && p.keyword).length)}
                </p>
              </>
            ) : (
              <p className="text-sm text-secondary">Not checked yet. Each run checks keywords once a week{showCost && " (≈ $0.0012 per keyword)"}.</p>
            )}
          </Section>

          <Section
            title="Mentions across AI answers"
            description={`How often each domain turns up in a database of AI answers, beyond your tracked questions. AI volume is the search volume of the questions that mention it. Refreshed weekly with the run${showCost ? ` (≈ ${formatUsd(LLM_MENTIONS_COST_USD)})` : ""}.${mentions ? ` Fetched ${formatDate(mentions.fetchedAt, timeZone)}.` : ""}`}
          >
            <WeeklyCheckFailed failure={mentionsFailedCheck} from={mentions?.fetchedAt ?? null} timeZone={timeZone} />
            {mentions ? (
              <DataTable
                filename="ai-mentions"
                searchable={false}
                columns={[
                  { key: "brand", label: "Brand" },
                  { key: "overview", label: "AI Overview", format: "number" },
                  { key: "chatgpt", label: "ChatGPT", format: "number" },
                  { key: "volume", label: "AI volume", format: "number" },
                ]}
                rows={[...new Set(mentions.rows.map((r) => r.domain))].map((domain) => {
                  const g = mentions.rows.find((r) => r.domain === domain && r.platform === "google");
                  const c = mentions.rows.find((r) => r.domain === domain && r.platform === "chat_gpt");
                  return { brand: g?.own || c?.own ? `${domain} (you)` : domain, overview: g?.mentions, chatgpt: c?.mentions, volume: (g?.aiSearchVolume ?? 0) + (c?.aiSearchVolume ?? 0) };
                })}
              />
            ) : (
              <p className="text-sm text-secondary">Fetched with the next run.</p>
            )}
          </Section>
        </>
      )}
    </>
  );
}

/** A weekly check the newest run made that couldn't run: when, why, and that the numbers below are from before it. */
function WeeklyCheckFailed({ failure, from, timeZone }: { failure: CheckFailure | null; from: Date | null; timeZone: string }) {
  if (!failure?.at) return null;
  return (
    <CheckFailureCallout
      title={`${lastTry(failure)} (${formatDateTimeZoned(failure.at, timeZone)})`}
      reason={failure.reason}
      from={from && `These are the ${formatShortDate(from, timeZone)} numbers.`}
      again={failureAgain(failure, null)}
      link={failureLink(failure)}
    />
  );
}

/**
 * Which prompts the numbers count, and the switch for the project's setting, which also applies
 * to the dashboard card, the projects overview and MCP.
 */
function BrandedNote({ projectId, counts, includesBranded }: { projectId: number; counts: { branded: number; nonBranded: number }; includesBranded: boolean }) {
  if (!counts.branded) return null;
  const plural = (n: number) => `${n} prompt${n === 1 ? "" : "s"}`;
  const link =
    "cursor-pointer rounded-sm text-fg underline decoration-muted underline-offset-[3px] hover:decoration-fg focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent";
  const toggle = (on: boolean, label: string) => (
    <form action={setIncludeBranded.bind(null, projectId, on)} className="inline">
      <button type="submit" className={link}>
        {label}
      </button>
    </form>
  );
  return (
    <div className="mb-4 text-xs text-muted">
      {!counts.nonBranded ? (
        <>Every prompt names your brand, so these numbers count branded prompts. Add questions that don’t name you to see how often AI recommends you unprompted.</>
      ) : includesBranded ? (
        <>
          Counting all {plural(counts.branded + counts.nonBranded)}, including {counts.branded} branded (the question names your brand), here and on the dashboard.{" "}
          {toggle(false, "Leave branded out")}
        </>
      ) : (
        <>
          Counting {plural(counts.nonBranded)} that don’t name your brand. {counts.branded} branded {counts.branded === 1 ? "prompt is" : "prompts are"} left out, since
          an answer to a question about you names you almost by definition.{" "}
          {toggle(true, "Count branded")}
        </>
      )}
    </div>
  );
}
