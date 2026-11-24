import { Suspense } from "react";
import { Callout } from "@/components/ui/callout";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Section } from "@/components/ui/section";
import { AI_ASSISTANT_NAMES } from "@/lib/ai-referrers";
import { formatNumber } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { AI_COUNTED, aiReferrals, analyticsSourceOf, SOURCE_LABEL } from "../ai-referrals";
import type { DateRange } from "../windowing";

type SourceProject = Pick<Project, "domain" | "workspaceId" | "ga4Property" | "posthogProject" | "plausibleSite" | "umamiSite">;

/** The sentence over the table. Pure. */
export function aiSentence(sessions: number, organic: number): string {
  if (!sessions) return "No sessions came from AI assistants in this period.";
  const s = `${formatNumber(sessions)} ${sessions === 1 ? "session" : "sessions"} came from AI assistants in this period`;
  return organic ? `${s}, against ${formatNumber(organic)} from organic search.` : `${s}.`;
}

async function AiAssistants({ project, period, organic }: { project: SourceProject; period: DateRange; organic: number }) {
  const r = await aiReferrals(project, period);
  if (r.state === "none") return null;
  if (r.state === "error") return <Callout title="Couldn't read visits from AI assistants">{r.message}</Callout>;
  if (!r.assistants.length) {
    return <EmptyState level={3} title={aiSentence(0, organic)} description={`SEOpen looks for visits from ${AI_ASSISTANT_NAMES} in what ${SOURCE_LABEL[r.source]} reports.`} />;
  }
  return (
    <>
      <p className="mb-3 text-sm text-secondary">{aiSentence(r.sessions, organic)}</p>
      <DataTable
        filename={`${project.domain}-ai-assistants`}
        initialSort={{ key: "sessions", desc: true }}
        columns={[
          { key: "name", label: "Assistant" },
          { key: "sessions", label: "Sessions", format: "number" },
          { key: "engagementRate", label: r.source === "ga4" ? "Engaged" : "Not bounced", format: "pct" },
          { key: "seenAs", label: `In ${SOURCE_LABEL[r.source]} as`, sortable: false },
        ]}
        rows={r.assistants.map((a) => ({ name: a.name, sessions: a.sessions, engagementRate: a.sessions ? a.engagedSessions / a.sessions : null, seenAs: a.seenAs.join(", ") }))}
      />
    </>
  );
}

/**
 * Sessions from AI assistants over the page's period, read from the project's Analytics source when
 * the page loads (nothing is stored), so it streams in on its own.
 */
export function AiAssistantsSection({ project, period, organic }: { project: SourceProject; period: DateRange; organic: number }) {
  const source = analyticsSourceOf(project)?.key;
  if (!source) return null;
  return (
    <Section title="AI assistants" description={`${AI_COUNTED[source]}. Read from ${SOURCE_LABEL[source]} when this page loads, for the same days as above.`}>
      <Suspense fallback={<p className="text-sm text-muted">Asking {SOURCE_LABEL[source]} for visits from AI assistants…</p>}>
        <AiAssistants project={project} period={period} organic={organic} />
      </Suspense>
    </Section>
  );
}
