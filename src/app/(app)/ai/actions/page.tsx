import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureStrip, FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { formatDate, formatNumber } from "@/lib/format";
import { newBriefHref } from "@/modules/content-briefs/href";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { ACTION_LABEL, ACTION_STATUSES, STATUS_LABEL, statusCounts, THREAD_RULE, type Action, type ActionStatus, type PromptActions } from "@/modules/ai/action-list";
import { saveAiActionToList, setAiActionStatus } from "@/modules/ai/actions";
import { AiTabs, RunStatus } from "@/modules/ai/components/chrome";
import { getAiActions, listPrompts } from "@/modules/ai/data";
import { platformLabel } from "@/modules/ai/platforms";

export const metadata = { title: "AI actions" };

const platforms = (list: string[]) => [...new Set(list)].map(platformLabel).join(", ");
const answers = (n: number) => `${formatNumber(n)} answer${n === 1 ? "" : "s"}`;

export default async function AiActionsPage({ searchParams }: PageProps<"/ai/actions">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const raw = (await searchParams).status;
  const status: ActionStatus | null = raw === "all" ? null : (ACTION_STATUSES.find((s) => s === raw) ?? "open");
  const [timeZone, prompts, view] = await Promise.all([currentTimeZone(), listPrompts(projectScope(project)), getAiActions(project)]);
  const day = (iso: string) => formatDate(iso, timeZone);
  const notNamed = view.prompts.filter((p) => p.state === "not_named");
  const confirming = view.prompts.filter((p) => p.state === "confirming");
  const resolved = view.prompts.filter((p) => p.state === "resolved");
  const counts = statusCounts(view.prompts);
  const newest = view.prompts.map((p) => p.runAt).sort().at(-1);
  const source = (iso: string) => `AI visibility run, ${day(iso)}`;
  const shown = notNamed
    .map((p) => ({ ...p, actions: status ? p.actions.filter((a) => a.status === status) : p.actions }))
    .filter((p) => p.actions.length || (p.noneBecause && status !== "done" && status !== "dismissed"));

  return (
    <>
      <PageHeader
        title="AI visibility"
        description={`What to do about each prompt whose latest answers don't name ${project.name}: a page to write, pages to get featured on, threads to join. Worked out from the stored answers${newest ? `, latest from the ${source(newest)}` : ""}. SEOpen never posts anywhere for you.`}
      />
      <AiTabs />
      <RunStatus scope={projectScope(project)} canRun={prompts.some((p) => p.active)} />

      {!prompts.length ? (
        <EmptyState title="No tracked prompts yet" description="Actions come from the answers to your tracked prompts." action={<ButtonLink href="/ai/prompts">Add prompts</ButtonLink>} />
      ) : !view.prompts.length ? (
        <EmptyState title="No answers yet" description="Actions appear after the first run has answers." />
      ) : (
        <>
          {newest && (
            <FigureStrip label="Prompts by state">
              <FigureView data={{ id: "not-named", state: "value", label: "Not named", value: formatNumber(notNamed.length), delta: null, caption: `prompts, ${source(newest)}` }} />
              <FigureView data={{ id: "confirming", state: "value", label: "Waiting to confirm", value: formatNumber(confirming.length), delta: null, caption: "named in the latest run only" }} />
              <FigureView data={{ id: "resolved", state: "value", label: "Resolved", value: formatNumber(resolved.length), delta: null, caption: "named in the latest two runs" }} />
            </FigureStrip>
          )}

          <SegmentedLinks
            label="Filter by status"
            className="mt-6 max-w-full overflow-x-auto [scrollbar-width:none]"
            options={[...ACTION_STATUSES, null].map((s) => ({
              href: s === "open" ? "/ai/actions" : `/ai/actions?status=${s ?? "all"}`,
              label: `${s ? STATUS_LABEL[s] : "All"} ${formatNumber(s ? counts[s] : counts.open + counts.done + counts.dismissed)}`,
              active: s === status,
            }))}
          />

          {!shown.length ? (
            <p className="mt-6 text-sm text-secondary">
              {notNamed.length ? `No ${status ? STATUS_LABEL[status].toLowerCase() : ""} actions.` : "Every prompt's latest answers name you, so there's nothing to do here."}
            </p>
          ) : (
            shown.map((p) => <PromptSection key={p.promptId} projectId={project.id} p={p} topic={prompts.find((x) => x.id === p.promptId)?.keyword ?? p.prompt} source={source(p.runAt)} day={day} />)
          )}

          {(confirming.length > 0 || resolved.length > 0) && (
            <Section title="Named in the latest run" description="A prompt counts as resolved once two runs in a row name you in every answer, because answers change from week to week.">
              <ul className="grid gap-2 text-sm">
                {[...confirming, ...resolved].map((p) => (
                  <li key={p.promptId} className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <Link href={`/ai/prompts/${p.promptId}`} className="mr-auto [overflow-wrap:anywhere] hover:underline">
                      {p.prompt}
                    </Link>
                    {p.branded && <Badge>Branded</Badge>}
                    <Badge tone={p.state === "resolved" ? "good" : "neutral"}>{p.state === "resolved" ? "Resolved" : "Waiting to confirm"}</Badge>
                    <span className="data text-xs text-muted">
                      {p.state === "resolved" && p.previous ? `${source(p.previous.runAt)} and ${day(p.runAt)}` : `${source(p.runAt)}; resolved if the next run names you too`}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Outreach list" description="Pages saved from Get featured actions, to ask about being listed or reviewed. Download it as CSV.">
            {view.saved.length ? (
              <DataTable
                filename="ai-outreach-list"
                searchable={false}
                columns={[
                  { key: "url", label: "Page", format: "url" },
                  { key: "domain", label: "Site" },
                  { key: "prompt", label: "Prompt" },
                  { key: "status", label: "Status", format: "badge" },
                  { key: "savedAt", label: "Saved", format: "date" },
                ]}
                rows={view.saved.map((s) => ({ ...s, status: STATUS_LABEL[s.status as ActionStatus] ?? s.status, savedAt: s.savedAt.toISOString() }))}
              />
            ) : (
              <p className="text-sm text-secondary">Nothing saved yet. Use Save to list on a Get featured action.</p>
            )}
          </Section>
        </>
      )}
    </>
  );
}

function PromptSection({ projectId, p, topic, source, day }: { projectId: number; p: PromptActions; topic: string; source: string; day: (iso: string) => string }) {
  return (
    <Section
      title={p.prompt}
      description={
        <>
          Not named in {formatNumber(p.missedOn.length)} of {answers(p.answered)} ({platforms(p.missedOn)}). {source}.
          {p.previous && ` The run before (${day(p.previous.runAt)}) ${p.previous.named ? "named you in every answer" : "didn't name you in every answer either"}.`}{" "}
          <Link href={`/ai/prompts/${p.promptId}`} className="underline decoration-muted underline-offset-[3px] hover:decoration-fg">
            Read the answers
          </Link>
        </>
      }
      actions={<Badge>{p.branded ? "Branded" : "Generic"}</Badge>}
    >
      {p.noneBecause && !p.actions.length ? (
        <p className="text-sm text-secondary">{p.noneBecause}</p>
      ) : (
        <ul className="grid">
          {p.actions.map((a) => (
            <ActionRow key={`${a.kind}:${a.url}`} projectId={projectId} promptId={p.promptId} topic={topic} a={a} source={source} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ActionRow({ projectId, promptId, topic, a, source }: { projectId: number; promptId: number; topic: string; a: Action; source: string }) {
  const ref = { promptId, kind: a.kind, url: a.url };
  const names = a.competitors.length ? `Competitors named in ${a.answers === 1 ? "that answer" : "those answers"}: ${a.competitors.join(", ")}.` : "No tracked competitor is named in them.";
  return (
    <li className="grid gap-2 border-t border-line py-4 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-medium">{ACTION_LABEL[a.kind]}</span>
        {a.status !== "open" && <Badge tone={a.status === "done" ? "good" : "neutral"}>{STATUS_LABEL[a.status]}</Badge>}
        {a.saved && <Badge tone="accent">On the outreach list</Badge>}
      </div>
      {a.kind === "write" ? (
        <p className="text-sm text-secondary">
          No page of yours is cited in these answers. Write a page that answers the question plainly, or extend the closest page you have. {names}
        </p>
      ) : (
        <div className="grid gap-1 text-sm">
          <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="font-mono text-xs [overflow-wrap:anywhere] text-fg underline decoration-muted underline-offset-[3px] hover:decoration-fg">
            {a.label}
          </a>
          {a.title && <span className="text-secondary [overflow-wrap:anywhere]">{a.title}</span>}
          <span className="text-secondary">
            Cited in {answers(a.answers)} that don&apos;t name you ({platforms(a.platforms)}). {names}
          </span>
          {a.kind === "thread" && <span className="text-secondary">{THREAD_RULE} SEOpen doesn&apos;t post for you.</span>}
        </div>
      )}
      <p className="data text-xs text-muted">{source}</p>
      <div className="flex flex-wrap gap-2">
        {a.status === "open" ? (
          <>
            <ActionForm action={setAiActionStatus.bind(null, projectId, ref, "done")}>
              <Button size="sm" variant="secondary" type="submit">
                Mark done
              </Button>
            </ActionForm>
            <ActionForm action={setAiActionStatus.bind(null, projectId, ref, "dismissed")}>
              <Button size="sm" variant="ghost" type="submit">
                Dismiss
              </Button>
            </ActionForm>
          </>
        ) : (
          <ActionForm action={setAiActionStatus.bind(null, projectId, ref, "open")}>
            <Button size="sm" variant="ghost" type="submit">
              Reopen
            </Button>
          </ActionForm>
        )}
        {a.kind === "write" && a.status === "open" && (
          <ButtonLink href={newBriefHref(topic, { from: "ai-action" })} prefetch={false} size="sm" variant="secondary">
            Create brief
          </ButtonLink>
        )}
        {a.kind === "featured" && (
          <ActionForm action={saveAiActionToList.bind(null, projectId, ref, !a.saved)}>
            <Button size="sm" variant="ghost" type="submit">
              {a.saved ? "Remove from list" : "Save to list"}
            </Button>
          </ActionForm>
        )}
      </div>
    </li>
  );
}
