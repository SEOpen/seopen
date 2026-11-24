import { ModuleList, ModuleListItem, ModuleSection, type DashboardModule } from "@/components/ui/module-card";
import { formatNumber } from "@/lib/format";
import type { Project } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { listSummaries } from "./lists";

const SHOWN = 5;

export interface KeywordsDashboardData {
  /** Keywords across all lists. */
  keywords: number;
  /** Number of lists. */
  lists: number;
  /** The most recently updated lists, at most five. */
  top: { id: number; name: string; keywords: number; volume: number }[];
}

/** Saved keyword lists for the project. Database reads only. */
async function load(project: Project): Promise<KeywordsDashboardData | null> {
  const lists = await listSummaries(projectScope(project));
  if (!lists.length) return null;
  return {
    keywords: lists.reduce((n, l) => n + l.keywords, 0),
    lists: lists.length,
    top: lists.slice(0, SHOWN).map((l) => ({ id: l.id, name: l.name, keywords: l.keywords, volume: l.volume })),
  };
}

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;

function describe(d: KeywordsDashboardData) {
  return `${plural(d.keywords, "saved keyword")} in ${plural(d.lists, "list")}`;
}

function View({ data: d }: { data: KeywordsDashboardData }) {
  return (
    <ModuleSection>
      <ModuleList>
        {d.top.map((l) => (
          <ModuleListItem key={l.id} href={`/keywords/lists/${l.id}`} label={l.name} meta={`${plural(l.keywords, "keyword")} · ${formatNumber(l.volume)} searches/mo`} />
        ))}
      </ModuleList>
    </ModuleSection>
  );
}

export const dashboard: DashboardModule<KeywordsDashboardData> = {
  id: "keywords",
  label: "Keyword lists",
  href: "/keywords/lists",
  setup: { text: "no saved keyword lists yet", href: "/keywords/lists" },
  load,
  describe,
  View,
};
