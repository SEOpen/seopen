import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { BackLink } from "@/components/ui/back-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { FigureStrip, FigureView } from "@/components/ui/figure";
import { Input, Label, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatDate, formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { deleteBriefAction, saveBriefAnswers, saveBriefOptions } from "@/modules/content-briefs/actions";
import { headingDepths } from "@/modules/content-briefs/headings";
import { currentOptions, currentOutline, TO_FILL } from "@/modules/content-briefs/markdown";
import { getBrief } from "@/modules/content-briefs/ops";
import { FIELD_MAX, OPTION_RANGE, toFill, usesOptions } from "@/modules/content-briefs/templates";
import { PAGE_TYPE_LABEL, SERP_TYPE_LABEL, type Source } from "@/modules/content-briefs/types";
import { href } from "@/modules/keywords/market";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "Content brief" };

const ExternalLink = ({ url, children }: { url: string; children?: ReactNode }) => (
  <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="font-mono text-xs [overflow-wrap:anywhere] text-fg underline decoration-muted underline-offset-[3px] hover:decoration-fg">
    {children ?? url}
  </a>
);

export default async function BriefPage({ params }: PageProps<"/keywords/briefs/[id]">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const view = await getBrief(projectScope(project), Number((await params).id));
  if (!view) notFound();
  const timeZone = await currentTimeZone();
  const day = (iso: string) => formatDate(iso, timeZone);
  const src = (s: Source | null) => (s ? `${s.label}${s.at ? `, ${day(s.at)}` : ""}` : "");
  const { brief, fill } = view;
  const t = brief.target;
  const missing = toFill(brief, fill);
  const options = currentOptions(brief, fill);
  const subject = [brief.template.x, brief.template.y].filter(Boolean).join(" and ");
  const n = (v: number | null) => (v == null ? "No data" : formatNumber(v));
  const optionRows = [...options, ...Array.from({ length: Math.max(0, OPTION_RANGE.max - options.length) }, () => null)].slice(0, brief.template.pageType === "vs" ? Math.max(2, options.length) : OPTION_RANGE.max);

  return (
    <>
      <BackLink href="/keywords/briefs">Briefs</BackLink>
      <PageHeader
        title={`Brief: ${view.keyword}`}
        description={`${PAGE_TYPE_LABEL[brief.template.pageType]}${subject ? ` (${subject})` : ""} for ${project.name}, ${brief.market.name}. Created ${day(brief.createdAt)}, ${view.creditsSpent ? `${rules.creditsText(view.creditsSpent)} spent` : `${rules.hasPlans ? `no ${rules.researchNoun}` : "nothing"} spent`}. A brief, never the article: write the page in your own words.`}
        actions={
          <a href={`/keywords/briefs/${view.id}/markdown`} className="text-sm text-accent underline-offset-3 hover:underline" download>
            Download Markdown
          </a>
        }
      />

      {missing.length > 0 ? (
        <Callout tone="warn" title={`${missing.length} still to fill`}>
          <ul className="mt-1 list-disc pl-5">
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Callout>
      ) : (
        <Callout title="Nothing left to fill">Everything only you can add is in. Write the page from this brief.</Callout>
      )}

      <Section title="1. Target" description={src(t.source)}>
        <FigureStrip label="Main keyword">
          <FigureView data={{ id: "volume", state: "value", label: "Searches a month", value: n(t.volume), delta: null, caption: t.keyword }} />
          <FigureView data={{ id: "kd", state: "value", label: "Difficulty", value: n(t.kd), delta: null, caption: "0 to 100" }} />
          <FigureView data={{ id: "intent", state: "value", label: "Intent", value: t.intent ?? "Not known", delta: null, caption: "provider's estimate" }} />
        </FigureStrip>
        {t.merged.length > 0 && (
          <div className="mt-4 text-sm">
            <p className="text-secondary">Also targeted on this page ({src(t.mergedSource)}):</p>
            <ul className="mt-1 grid gap-1">
              {t.merged.map((k) => (
                <li key={k.keyword}>
                  {k.keyword} <span className="data text-xs text-muted">volume {n(k.volume)}, difficulty {n(k.kd)}, {k.intent ?? "intent not known"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="2. What ranks" description={src(brief.serp.source) || "No top 10 lookup"}>
        {brief.serp.total ? (
          <>
            <p className="text-sm">
              {brief.serp.dominant ? `Mostly ${SERP_TYPE_LABEL[brief.serp.dominant].toLowerCase()} pages: ${brief.serp.agree} of ${brief.serp.total}.` : `No single page type leads: the most common is ${brief.serp.agree} of ${brief.serp.total}.`}
            </p>
            {(brief.serp.warning || brief.serp.fit) && (
              <div className="mt-3 grid gap-2">
                {brief.serp.warning && <Callout tone="warn">{brief.serp.warning}</Callout>}
                {brief.serp.fit && <Callout tone="warn">{brief.serp.fit}</Callout>}
              </div>
            )}
            <ol className="mt-4 grid gap-2 text-sm">
              {brief.serp.results.map((r) => (
                <li key={`${r.position}-${r.url}`} className="grid gap-0.5">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="data text-xs text-muted">{r.position}</span>
                    <span className="[overflow-wrap:anywhere]">{r.title ?? r.domain}</span>
                    <Badge>{r.type ? SERP_TYPE_LABEL[r.type] : "Not classified"}</Badge>
                    {r.isProject && <Badge tone="accent">Yours</Badge>}
                  </span>
                  <span className="pl-6 text-xs text-muted">
                    {r.url ? <ExternalLink url={r.url} /> : "Address hidden"} · {r.why}
                  </span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-sm text-secondary">No top 10 results were found.</p>
        )}
      </Section>

      <Section title="3. AI Overview" description={src(brief.aiOverview.source)}>
        {brief.aiOverview.present ? (
          <>
            <p className="text-sm">Google shows an AI Overview. {brief.aiOverview.cited.length ? `It cites ${brief.aiOverview.cited.length} page${brief.aiOverview.cited.length === 1 ? "" : "s"}:` : "It cites no pages."}</p>
            <ul className="mt-2 grid gap-1 text-sm">
              {brief.aiOverview.cited.map((c) => (
                <li key={c.url ?? c.domain}>
                  {c.title ?? c.domain} {c.url && <ExternalLink url={c.url} />}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-secondary">No AI Overview in this lookup.{brief.aiOverview.loaded ? "" : " It used a top 10 from Keyword research, which doesn't ask Google for one that loads late, so one may still appear."}</p>
        )}
      </Section>

      <Section title="4. Questions to answer" description={[brief.questions.paa.length ? `People also ask: ${src(brief.questions.paaSource)}` : "", brief.questions.keywords.length ? `Question keywords: ${src(brief.questions.keywordsSource)}` : ""].filter(Boolean).join(". ")}>
        {brief.questions.paa.length || brief.questions.keywords.length ? (
          <div className="grid gap-4 text-sm @3xl/main:grid-cols-2">
            {brief.questions.paa.length > 0 && (
              <div>
                <h3 className="caps-label">People also ask</h3>
                <ul className="mt-1 grid gap-1">
                  {brief.questions.paa.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            )}
            {brief.questions.keywords.length > 0 && (
              <div>
                <h3 className="caps-label">Question keywords</h3>
                <ul className="mt-1 grid gap-1">
                  {brief.questions.keywords.map((k) => (
                    <li key={k.keyword}>
                      {k.keyword} <span className="data text-xs text-muted">{n(k.volume)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-secondary">No questions were found for this keyword.</p>
        )}
      </Section>

      <Section title="5. What the top 3 cover" description={brief.top3.source ? `Headings ${brief.top3.source.label.toLowerCase()}, ${brief.top3.source.at ? day(brief.top3.source.at) : ""}` : undefined}>
        <div className="grid gap-5">
          {brief.top3.pages.map((p) => (
            <div key={p.position} className="text-sm">
              <h3 className="font-medium [overflow-wrap:anywhere]">
                {p.position}. {p.title ?? p.domain}
              </h3>
              {p.url && <ExternalLink url={p.url} />}
              {p.read === "read" ? (
                p.headings.length ? (
                  <ul className="mt-2 grid gap-0.5">
                    {headingDepths(p.headings).map((depth, i) => (
                      <li key={i} className="text-secondary [overflow-wrap:anywhere]" style={{ paddingLeft: `${depth}rem` }}>
                        <span className="data text-xs text-muted">H{p.headings[i].level}</span> {p.headings[i].text}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-secondary">The page had no H1 to H3 headings.</p>
                )
              ) : (
                <p className="mt-1 text-secondary">Only the title is known: {p.why}</p>
              )}
            </div>
          ))}
          {!brief.top3.pages.length && <p className="text-sm text-secondary">There were no organic results to read.</p>}
        </div>
      </Section>

      <Section title="6. Outline" description="Headings only, each with where it came from. No claims: what goes under each is yours to write.">
        <ul className="grid gap-1 text-sm">
          {currentOutline(brief, fill).map((h, i) => (
            <li key={i} className={h.level === 3 ? "pl-5" : ""}>
              <span className="data text-xs text-muted">H{h.level}</span> <span className={h.level === 2 ? "font-medium" : ""}>{h.text}</span> <span className="text-xs text-muted">({h.from})</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="7. Only you can add these" description="Required. The angle the top 3 miss, and what only you have. Without them the page reads like every other result.">
        <ActionForm action={saveBriefAnswers.bind(null, project.id, view.id)} className="grid max-w-3xl gap-4">
          <div className="grid gap-1.5">
            <Label htmlFor="angle">The angle the top 3 all miss {fill.angle?.trim() ? "" : <Badge tone="warn">{TO_FILL}</Badge>}</Label>
            <Textarea id="angle" name="angle" rows={3} maxLength={FIELD_MAX.angle} defaultValue={fill.angle ?? ""} placeholder="What none of them says that you can, from section 5." />
          </div>
          {brief.ownerInputs.map((input) => (
            <div key={input.id} className="grid gap-1.5">
              <Label htmlFor={`input-${input.id}`}>
                {input.prompt} {fill.inputs?.[input.id]?.trim() ? "" : <Badge tone="warn">{TO_FILL}</Badge>}
              </Label>
              <Textarea id={`input-${input.id}`} name={`input:${input.id}`} rows={3} maxLength={FIELD_MAX.input} defaultValue={fill.inputs?.[input.id] ?? ""} />
            </div>
          ))}
          <div>
            <Button type="submit" variant="secondary">
              Save answers
            </Button>
          </div>
        </ActionForm>
      </Section>

      {usesOptions(brief.template.pageType) && (
        <Section
          title={brief.template.pageType === "vs" ? "The two sides" : "Options"}
          description={`${brief.template.pageType === "alternatives" ? `${OPTION_RANGE.min} to ${OPTION_RANGE.max} options, never your own site first, one real drawback each. ` : brief.template.pageType === "best" ? "Never your own site first, one real drawback each. " : ""}Every price needs the date you checked it on the vendor's own page. Proposed from your tracked competitors and the top 10; change them freely.`}
        >
          <ActionForm action={saveBriefOptions.bind(null, project.id, view.id)} className="grid gap-4">
            {optionRows.map((o, i) => (
              <fieldset key={i} className="grid gap-2 border-t border-line pt-3 @3xl/main:grid-cols-[1fr_1fr_8rem_9rem]">
                <legend className="sr-only">Option {i + 1}</legend>
                <div className="grid gap-1">
                  <Label htmlFor={`name-${i}`}>{i + 1}. Name</Label>
                  <Input id={`name-${i}`} name={`name:${i}`} defaultValue={o?.name ?? ""} maxLength={FIELD_MAX.optionName} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`url-${i}`}>Address</Label>
                  <Input id={`url-${i}`} name={`url:${i}`} defaultValue={o?.url ?? ""} maxLength={FIELD_MAX.url} />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`price-${i}`}>Price</Label>
                  <Input id={`price-${i}`} name={`price:${i}`} defaultValue={o?.price ?? ""} maxLength={FIELD_MAX.price} placeholder="$29 a month" />
                </div>
                <div className="grid gap-1">
                  <Label htmlFor={`on-${i}`}>Checked on</Label>
                  <Input id={`on-${i}`} type="date" name={`priceCheckedOn:${i}`} defaultValue={o?.priceCheckedOn ?? ""} />
                </div>
                <div className="grid gap-1 @3xl/main:col-span-4">
                  <Label htmlFor={`drawback-${i}`}>One real drawback {o?.name && !o.drawback ? <Badge tone="warn">{TO_FILL}</Badge> : null}</Label>
                  <Input id={`drawback-${i}`} name={`drawback:${i}`} defaultValue={o?.drawback ?? ""} maxLength={FIELD_MAX.drawback} />
                </div>
              </fieldset>
            ))}
            <div>
              <Button type="submit" variant="secondary">
                Save options
              </Button>
            </div>
          </ActionForm>
        </Section>
      )}

      <Section title="8. Internal links" description="From your Search Console data and latest site audit.">
        {brief.internalLinks.note && <p className="mb-3 text-sm text-secondary">{brief.internalLinks.note}</p>}
        <div className="grid gap-4 text-sm @3xl/main:grid-cols-2">
          {brief.internalLinks.from.length > 0 && (
            <div>
              <h3 className="caps-label">Link to the new page from</h3>
              <ul className="mt-1 grid gap-2">
                {brief.internalLinks.from.map((l) => (
                  <li key={l.url} className="grid gap-0.5">
                    <ExternalLink url={l.url} />
                    <span className="text-secondary">{l.why}</span>
                    <span className="data text-xs text-muted">{src(l.source)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {brief.internalLinks.to.length > 0 && (
            <div>
              <h3 className="caps-label">Link from the new page to</h3>
              <ul className="mt-1 grid gap-2">
                {brief.internalLinks.to.map((l) => (
                  <li key={l.url} className="grid gap-0.5">
                    <ExternalLink url={l.url} />
                    <span className="text-secondary">{l.why}</span>
                    <span className="data text-xs text-muted">{src(l.source)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Section>

      <Card className="mt-8">
        <CardHeader title="Brief settings" />
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <a href={href("/keywords", { q: view.keyword, loc: brief.market.locationCode })} className="text-sm text-accent underline-offset-3 hover:underline">
            Open “{view.keyword}” in Keyword research
          </a>
          <ActionForm action={deleteBriefAction.bind(null, project.id, view.id)} align="end">
            <ConfirmSubmit variant="danger" question={`Delete the brief for “${view.keyword}”?`} confirmLabel="Delete brief">
              Delete brief
            </ConfirmSubmit>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}
