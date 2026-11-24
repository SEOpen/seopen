import Link from "next/link";
import { notFound } from "next/navigation";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { BackLink } from "@/components/ui/back-link";
import { Badge } from "@/components/ui/badge";
import { Briefing } from "@/components/ui/briefing";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { locationName } from "@/lib/dataforseo/locations";
import { formatDate } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { deleteTeardownAction } from "@/modules/domains/actions";
import { domainFigures } from "@/modules/domains/brief";
import { rankOverviewSpec } from "@/modules/domains/requests";
import { MOVE_SIZE_LABEL, splitLead } from "@/modules/domains/teardown-text";
import { getTeardown } from "@/modules/domains/teardowns";
import { kpis } from "@/modules/domains/transform";
import type { RankOverviewResult } from "@/modules/domains/types";
import { loadOnce, settle } from "@/modules/keywords/dfs";
import { listOptions } from "@/modules/keywords/lists";
import { href, resolveMarket } from "@/modules/keywords/market";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "Teardown" };

/** Plain text in paragraphs. Much of a teardown was read off other sites, so it's never parsed as HTML or Markdown. */
function Paragraphs({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <div className={className}>
      {text.split("\n\n").map((p, i) => (
        <p key={i} className="max-w-[68ch] text-sm leading-6 whitespace-pre-line text-fg [overflow-wrap:anywhere] [&:not(:first-child)]:mt-3">
          {p}
        </p>
      ))}
    </div>
  );
}

const linkClass = "text-sm text-accent underline-offset-3 hover:underline";

export default async function TeardownPage({ params }: PageProps<"/domains/teardowns/[id]">) {
  const id = Number((await params).id);
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const scope = projectScope(project);
  const t = Number.isInteger(id) && id > 0 ? await getTeardown(scope, id) : null;
  if (!t) notFound();
  const market = resolveMarket(String(t.locationCode), project);
  // The same lookup the Overview link opens. Read from the cache only (run: false), so this page never spends.
  const [timeZone, lists, overview] = await Promise.all([
    currentTimeZone(),
    listOptions(scope),
    settle(() => loadOnce<RankOverviewResult>(rankOverviewSpec(t.domain, market), { run: false, workspaceId: scope.workspaceId, projectId: scope.projectId })),
  ]);
  const organic = overview.ok && overview.value.state === "ready" ? overview.value.results[0]?.items?.[0]?.metrics.organic : undefined;
  const readAt = overview.ok && overview.value.state === "ready" ? overview.value.fetchedAt : null;
  const figures = organic && kpis(organic) ? domainFigures(organic, null, readAt ?? new Date()) : [];

  // The teardown skill saves the target's best keywords under this name.
  const keywordList = lists.find((l) => l.name === `Teardown: ${t.domain}`);
  const { lead, rest } = splitLead(t.summary);
  const p = { q: t.domain, loc: t.locationCode };
  const overviewHref = href("/domains", p);
  const numbers = [
    { href: overviewHref, label: "Overview" },
    { href: href("/domains/pages", p), label: "Top pages and sections" },
    { href: href("/domains/keywords", p), label: "Keywords" },
    { href: href("/backlinks/links", { q: t.domain, view: "page" }), label: "Most-linked pages" },
    ...(keywordList ? [{ href: `/keywords/lists/${keywordList.id}`, label: "Saved keyword list" }] : []),
  ];
  const details = [
    { term: "For", value: project.name },
    { term: "Market", value: locationName(t.locationCode) },
    { term: "Saved", value: `${formatDate(t.createdAt, timeZone)}${t.savedBy ? ` by ${t.savedBy}` : ""}` },
    { term: rules.hasPlans ? "Credits" : "Spent", value: t.creditsSpent ? rules.creditsText(t.creditsSpent) : "None spent" },
  ];

  return (
    <>
      <BackLink href="/domains/teardowns">Teardowns</BackLink>
      <PageHeader
        title={`Teardown: ${t.domain}`}
        description={`${t.moves.length} ${t.moves.length === 1 ? "move" : "moves"} for your site, from ${t.findings.length} ${t.findings.length === 1 ? "finding" : "findings"}.`}
        actions={
          <a href={`/domains/teardowns/${t.id}/markdown`} className={linkClass} download>
            Download Markdown
          </a>
        }
      />

      {/* One column on a narrow screen: verdict and moves, then the rail, then the evidence. From 64rem the rail sits beside both. */}
      <div className="module-rail mt-2">
        <div className="@5xl/main:col-start-1 @5xl/main:row-start-1">
          <Briefing sentence={lead}>
            {figures.length > 0 && figures.map((f) => <FigureView key={f.id} data={f} />)}
          </Briefing>
          {figures.length > 0 ? (
            <p className="mt-2 text-xs text-muted">
              {t.domain} in {locationName(t.locationCode)}, looked up {readAt ? formatDate(readAt, timeZone) : "recently"}. Provider estimates, not its real traffic.
            </p>
          ) : (
            <p className="mt-3 text-xs text-muted">
              The saved numbers for {t.domain} have expired. <Link href={overviewHref} className="text-accent underline-offset-3 hover:underline">Open the Overview</Link> to look them up again.
            </p>
          )}
          <Paragraphs text={rest} className="mt-6" />

          <Section title="Moves for your site" className="mt-10">
            <ol className="border-t border-line-soft">
              {t.moves.map((m, i) => (
                <li key={i} className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-3 border-b border-line-soft py-6 @2xl/main:grid-cols-[3rem_minmax(0,1fr)]">
                  <span aria-hidden className="text-[28px] leading-[1.1] font-medium tracking-[-0.02em] text-muted">
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
                      <h3 className="max-w-[60ch] text-[17px] leading-snug font-medium text-pretty [overflow-wrap:anywhere]">{m.title}</h3>
                      {m.size !== "page" && <Badge className="mt-0.5">{MOVE_SIZE_LABEL[m.size] ?? m.size}</Badge>}
                    </div>
                    <Paragraphs text={m.why} className="mt-2 [&_p]:text-secondary" />
                    <p className="mt-3 max-w-[68ch] text-sm leading-6 [overflow-wrap:anywhere]">
                      <span className="font-medium">First step: </span>
                      {m.firstStep}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </Section>
        </div>

        <aside className="flex flex-col gap-3 self-start @5xl/main:sticky @5xl/main:top-6 @5xl/main:col-start-2 @5xl/main:row-span-2 @5xl/main:row-start-1" aria-label="About this teardown">
          <Card>
            <CardHeader title="About this teardown" />
            <CardBody>
              <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
                {details.map((d) => (
                  <div key={d.term} className="contents">
                    <dt className="text-muted">{d.term}</dt>
                    <dd className="[overflow-wrap:anywhere]">{d.value}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="The numbers" description="Free while the lookups are saved. Past that, each page asks before spending." />
            <CardBody>
              <ul className="flex flex-col gap-2">
                {numbers.map((n) => (
                  <li key={n.href}>
                    <Link href={n.href} className={linkClass}>
                      {n.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardBody>
          </Card>
          <ActionForm action={deleteTeardownAction.bind(null, t.id)} className="px-1">
            <ConfirmSubmit variant="danger" question={`Delete the teardown of ${t.domain}?`} confirmLabel="Delete teardown">
              Delete teardown
            </ConfirmSubmit>
          </ActionForm>
        </aside>

        {t.findings.length > 0 && (
          <Section title={`What ${t.domain} does`} description="The evidence behind the moves, read off the site and its numbers." className="mt-4 @5xl/main:col-start-1 @5xl/main:row-start-2 @5xl/main:mt-10">
            <div className="flex flex-col divide-y divide-line-soft">
              {t.findings.map((f, i) => (
                <article key={i} className="py-5 first:pt-1">
                  <h3 className="text-[15px] font-medium [overflow-wrap:anywhere]">{f.title}</h3>
                  <Paragraphs text={f.body} className="mt-2" />
                </article>
              ))}
            </div>
          </Section>
        )}
      </div>
    </>
  );
}
