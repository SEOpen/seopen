"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { FigureStrip, FigureView } from "@/components/ui/figure";
import { RetryButton } from "@/components/ui/retry-button";
import { Segmented } from "@/components/ui/segmented";
import { Sparkline } from "@/components/ui/sparkline";
import type { ClicksSpark as Spark, ProjectSummary } from "./project-summary";

export interface BoardProject {
  id: number;
  name: string;
  domain: string;
  locked: boolean;
  summary: ProjectSummary;
}

const SORTS = ["Needs a look", "Name", "Biggest change"] as const;
type Sort = (typeof SORTS)[number];

const byName = (a: BoardProject, b: BoardProject) => a.name.localeCompare(b.name);

function sorted(projects: BoardProject[], sort: Sort) {
  const out = [...projects];
  if (sort === "Name") return out.sort(byName);
  if (sort === "Biggest change") return out.sort((a, b) => b.summary.biggest - a.summary.biggest || byName(a, b));
  // A project with a failed check, or that couldn't load, comes after real falls and before anything steady.
  const rank = (p: BoardProject) => p.summary.worst || (p.summary.failed.length || p.summary.looking ? 0.001 : 0);
  return out.sort((a, b) => rank(b) - rank(a) || byName(a, b));
}

/** Every project, the ones with something to read first. The ones still waiting, then the ones with nothing set up, end the page quietly. */
export function ProjectBoard({ projects }: { projects: BoardProject[] }) {
  const [sort, setSort] = useState<Sort>("Needs a look");
  const live = useMemo(() => sorted(projects.filter((p) => p.summary.status === "attention" || p.summary.status === "steady"), sort), [projects, sort]);
  const waiting = useMemo(() => projects.filter((p) => p.summary.status === "waiting").sort(byName), [projects]);
  const empty = useMemo(() => projects.filter((p) => p.summary.status === "empty").sort(byName), [projects]);
  return (
    <>
      {live.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Sort by</span>
          <Segmented label="Sort projects by" options={SORTS} value={sort} onChange={setSort} />
        </div>
      )}
      {live.length > 0 && (
        <ul className="flex flex-col gap-3">
          {live.map((p) => (
            <li key={p.id}>
              <ProjectCard project={p} />
            </li>
          ))}
        </ul>
      )}
      {waiting.length > 0 && <QuietList id="board-waiting" title="Waiting for first results" projects={waiting} waiting />}
      {empty.length > 0 && <QuietList id="board-empty" title="Nothing set up yet" projects={empty} />}
    </>
  );
}

/**
 * One project's card. Pure, so /dev/cards can render it from fixtures. A white sheet on the paper column
 * (a filled step in dark): name and domain, the sentence, the clicks line, then the six figures as one
 * ruled row, so nothing is a grey tile on a grey panel.
 */
export function ProjectCard({ project: p }: { project: BoardProject }) {
  const s = p.summary;
  return (
    <article className="@container/card panel relative overflow-clip transition-colors duration-[120ms] ease-instrument hover:bg-[color-mix(in_srgb,var(--surface)_96%,var(--fg))] has-[a:focus-visible]:outline-2 has-[a:focus-visible]:-outline-offset-2 has-[a:focus-visible]:outline-accent motion-reduce:transition-none">
      <div className="flex flex-wrap items-start justify-between gap-x-10 gap-y-4 p-4 @[34rem]/card:px-5">
        <div className="min-w-0 flex-[1_1_22rem]">
          <h2 className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
            {/* Opening a project also makes it the current one (proxy.ts), so a prefetch must not. */}
            <Link href={`/projects/${p.id}`} prefetch={false} className="min-w-0 text-[17px] leading-6 font-medium [overflow-wrap:anywhere] outline-none after:absolute after:inset-0 hover:underline hover:decoration-tick hover:underline-offset-4">
              {p.name}
            </Link>
            {p.name !== p.domain && <span className="min-w-0 text-[13px] break-all text-muted">{p.domain}</span>}
            {s.status === "attention" && <Badge tone="warn" className="self-center">Needs a look</Badge>}
            {p.locked && <Badge className="self-center">Read-only</Badge>}
          </h2>
          <p className="mt-1.5 max-w-[64ch] text-sm text-pretty text-secondary">{s.sentence}</p>
          {s.failed.length > 0 && (
            <p className="relative z-[1] mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-bad">
              {s.failed.map((f) => `${f.label} ${f.slow ? "took too long to load" : "couldn't load"}`).join(". ")}.
              <RetryButton />
            </p>
          )}
        </div>
        {s.clicksSpark && <ClicksSpark spark={s.clicksSpark} />}
      </div>
      <FigureStrip label={`${p.name}: key numbers`} variant="ruled">
        {s.figures.map((f) => (
          <FigureView key={f.id} data={f} small />
        ))}
      </FigureStrip>
    </article>
  );
}

/**
 * The card's one chart, in data blue as a primary series is. It takes no direction colour: the Clicks delta
 * below says better or worse. The caption repeats the name the line is read aloud by, so it's hidden from screen readers.
 */
function ClicksSpark({ spark }: { spark: Spark }) {
  return (
    <figure className="w-56 max-w-full shrink-0">
      <Sparkline points={spark.points} label={spark.label} wide className="h-14 w-full" />
      <figcaption aria-hidden className="mt-1.5 text-xs text-muted">
        {spark.label}
      </figcaption>
    </figure>
  );
}

/** A plain list of projects with no numbers to show. `waiting`: each is set up, so it says what it's waiting for and offers no setup. */
function QuietList({ id, title, projects, waiting = false }: { id: string; title: string; projects: BoardProject[]; waiting?: boolean }) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-[15px] font-medium">
        {title}
      </h2>
      <ul className="mt-2 divide-y divide-line-soft border-y border-line-soft text-sm">
        {projects.map((p) => (
          <li key={p.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 py-2.5">
            <Link href={`/projects/${p.id}`} prefetch={false} className="min-w-0 font-medium [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
              {p.name}
            </Link>
            {p.name !== p.domain && <span className="min-w-0 flex-1 text-[13px] break-all text-muted">{p.domain}</span>}
            {p.locked ? (
              <Badge className="ml-auto">Read-only</Badge>
            ) : (
              !waiting && (
                <Link href={`/projects/${p.id}/setup`} prefetch={false} className="ml-auto inline-flex min-h-6 items-center gap-1 text-xs font-medium text-accent underline-offset-3 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
                  Set up
                  <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
                </Link>
              )
            )}
            {waiting && <p className="w-full max-w-[69ch] text-pretty text-secondary">{p.summary.sentence}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}
