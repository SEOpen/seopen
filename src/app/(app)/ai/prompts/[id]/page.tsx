import { notFound } from "next/navigation";
import { NoProject } from "@/components/require-project";
import { BackLink } from "@/components/ui/back-link";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable } from "@/components/ui/data-table";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { isInternal, showsDollarCosts } from "@/lib/billing/gates";
import { plainAiFailure } from "@/lib/dataforseo/failure-copy";
import { formatDate, formatDateTime, formatShortDate, formatUsd } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone, currentWorkspace } from "@/lib/workspace/current";
import { promptFigures, promptSentence, type PromptAnswer } from "@/modules/ai/brief";
import { HighlightedAnswer, Legend } from "@/modules/ai/components/answer";
import { AiTabs, RunStatus } from "@/modules/ai/components/chrome";
import { PromptSettings } from "@/modules/ai/components/prompt-settings";
import { getPromptDetail, listTopics } from "@/modules/ai/data";
import { citationLabel, hostMatches, namesBrand, readCitation } from "@/modules/ai/detect";
import { PLATFORMS, platformLabel } from "@/modules/ai/platforms";
import { costRates, loadBrands } from "@/modules/ai/run";

export const metadata = { title: "AI prompt" };

export default async function AiPromptPage({ params }: PageProps<"/ai/prompts/[id]">) {
  const { id } = await params;
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const promptId = Number(id);
  if (!Number.isInteger(promptId)) notFound();
  const [ws, timeZone, detail, brands, rates, topics] = await Promise.all([
    currentWorkspace(),
    currentTimeZone(),
    getPromptDetail(projectScope(project), promptId),
    loadBrands(project),
    costRates(project.workspaceId),
    listTopics(projectScope(project)),
  ]);
  const showCost = showsDollarCosts(ws);
  if (!detail) notFound();
  const { prompt, latest, history, aio } = detail;
  const own = brands[0];
  const nameOf = (domain: string) => brands.find((b) => b.domain === domain)?.name ?? domain;
  const lastAio = aio.find((a) => a.status === "done");
  // Failed answers go in too, so an assistant whose latest answer failed is left out of the counts rather than counted on an older answer.
  const answers: PromptAnswer[] = history
    .filter((h) => h.status === "done" || h.status === "failed")
    .map((h) => ({ platform: platformLabel(h.platform), day: formatShortDate(h.startedAt, timeZone), named: !!h.mentioned, cited: !!h.cited, position: h.position, failed: h.status === "failed" }));
  const shownPlatforms = PLATFORMS.filter((p) => prompt.platforms.includes(p.key) || latest.has(p.key));

  return (
    <>
      <BackLink href="/ai/prompts">Prompts</BackLink>
      <PageHeader
        title={prompt.prompt}
        description={
          <>
            {prompt.topic && <>{prompt.topic} · </>}added {formatDate(prompt.createdAt, timeZone)}
            {prompt.source === "suggested" ? " from a suggestion" : " by hand"}
            {!prompt.active && " · paused"}
            {namesBrand(prompt.prompt, own) && (
              <>
                {" "}
                <Badge title="The prompt names your brand, so it isn't counted in Overview by default">Branded</Badge>
              </>
            )}
          </>
        }
      />
      <AiTabs />
      {/* This page has no Run now. */}
      <RunStatus scope={projectScope(project)} canRun={false} />

      <Briefing sentence={promptSentence(answers, prompt.active)}>
        {promptFigures(answers, lastAio ? { present: !!lastAio.present, cited: !!lastAio.cited, keyword: lastAio.keyword, day: formatShortDate(lastAio.completedAt ?? lastAio.createdAt, timeZone) } : null, !!prompt.keyword).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      <div className="module-rail">
        <div className="min-w-0">
          {shownPlatforms.map((p, i) => {
            const r = latest.get(p.key);
            return (
              <Section
                key={p.key}
                title={p.label}
                className={i === 0 ? "mt-6" : undefined}
                description={r ? `${r.model ?? p.model} · ${formatDateTime(r.completedAt, timeZone)}${showCost ? ` · ${formatUsd(r.costUsd, 4)}` : ""}` : "No answer yet"}
                actions={
                  r ? (
                    <>
                      {r.mentioned ? <Badge tone="good">named{r.position ? ` · #${r.position}` : ""}</Badge> : <Badge>not named</Badge>}
                      {r.cited && <Badge tone="accent">cited</Badge>}
                      <Legend />
                    </>
                  ) : undefined
                }
              >
                {r && (
                  <div className="grid gap-4">
                    <HighlightedAnswer text={r.answer ?? ""} brands={brands} />
                    {(r.mentions ?? []).some((m) => m.count > 0) && (
                      <div className="flex flex-wrap gap-1.5 text-xs">
                        <span className="text-muted">Brands named:</span>
                        {(r.mentions ?? [])
                          .filter((m) => m.count > 0)
                          .sort((a, b) => (a.position ?? 99) - (b.position ?? 99))
                          .map((m) => (
                            <Badge key={m.domain} tone={m.own ? "accent" : "neutral"}>
                              #{m.position} {nameOf(m.domain)} ×{m.count}
                            </Badge>
                          ))}
                      </div>
                    )}
                    <div>
                      <h3 className="mb-1.5 text-xs font-medium text-muted">Sources ({r.citations?.length ?? 0})</h3>
                      {r.citations?.length ? (
                        <ol className="grid list-decimal gap-1 pl-5 text-sm [overflow-wrap:anywhere]">
                          {r.citations.map((stored) => {
                            const c = readCitation(stored);
                            const ours = !!c.domain && own.domains.some((d) => hostMatches(c.domain!, d));
                            return (
                              <li key={c.url} className="min-w-0">
                                <a href={c.url} target="_blank" rel="noreferrer" className={ours ? "font-medium text-fg underline-offset-3 hover:underline" : "text-accent underline-offset-3 hover:underline"}>
                                  {c.title || citationLabel(c)}
                                </a>{" "}
                                <span className="text-xs text-muted">
                                  {c.domain ?? (c.gemini ? "source hidden by Gemini" : null)}
                                  {ours && ", your site"}
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      ) : (
                        <p className="text-sm text-muted">No sources cited.</p>
                      )}
                    </div>
                  </div>
                )}
              </Section>
            );
          })}

          {lastAio && (
            <Section
              title="Google AI Overview"
              description={`“${lastAio.keyword}” · ${formatDateTime(lastAio.completedAt, timeZone)}`}
              actions={lastAio.present ? <Badge tone={lastAio.cited ? "accent" : "neutral"}>{lastAio.cited ? "shown · cites you" : "shown"}</Badge> : <Badge>none</Badge>}
            >
              {lastAio.present && (
                <div className="grid gap-4">
                  {lastAio.text && <HighlightedAnswer text={lastAio.text} brands={brands} />}
                  <ol className="grid list-decimal gap-1 pl-5 text-sm [overflow-wrap:anywhere]">
                    {(lastAio.references ?? []).map((c) => (
                      <li key={c.url}>
                        <a href={c.url} target="_blank" rel="noreferrer" className="text-accent underline-offset-3 hover:underline">
                          {c.title || c.url}
                        </a>{" "}
                        <span className="text-xs text-muted">{c.domain}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </Section>
          )}

          <Section title="History">
            <DataTable
              filename={`ai-prompt-${prompt.id}-history`}
              searchable={false}
              columns={[
                { key: "date", label: "Run", data: true },
                { key: "platform", label: "Platform", format: "badge" },
                { key: "status", label: "Status" },
                { key: "mentioned", label: "Named" },
                ...(history.some((h) => h.position != null) ? [{ key: "position", label: "Position", format: "position" as const }] : []),
                { key: "cited", label: "Cited" },
                { key: "sources", label: "Sources", format: "number" as const },
                // SEOpen's own cost: internal, so it isn't even sent to anyone else's browser.
                ...(showCost ? [{ key: "cost", label: "Cost", format: "usd" as const }] : []),
              ]}
              rows={history.map((h) => ({
                date: formatDate(h.startedAt, timeZone),
                platform: platformLabel(h.platform),
                status: h.status === "failed" ? `failed: ${isInternal(ws) && h.error ? h.error : plainAiFailure(h.error)}` : h.status,
                mentioned: h.status === "done" ? (h.mentioned ? "yes" : "no") : "–",
                position: h.position,
                cited: h.status === "done" ? (h.cited ? "yes" : "no") : "–",
                sources: h.citations?.length ?? null,
                ...(showCost ? { cost: h.costUsd } : {}),
              }))}
            />
          </Section>
        </div>

        <Card className="mt-6 self-start">
          <CardHeader title="Settings" />
          <CardBody>
            <PromptSettings projectId={project.id} prompt={prompt} topics={topics} rates={showCost ? rates : { perAnswer: {}, aio: 0 }} showCost={showCost} />
          </CardBody>
        </Card>
      </div>
    </>
  );
}
