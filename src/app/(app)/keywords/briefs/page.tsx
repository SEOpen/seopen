import { NoProject } from "@/components/require-project";
import { ButtonLink } from "@/components/ui/button";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { listBriefs } from "@/modules/content-briefs/ops";
import { toFill } from "@/modules/content-briefs/templates";
import { PAGE_TYPE_LABEL } from "@/modules/content-briefs/types";
import { keywordTabs } from "@/modules/keywords/market";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "Content briefs" };

const COLUMNS: ColumnSpec[] = [
  { key: "keyword", label: "Keyword", format: "link", href: "/keywords/briefs/{id}" },
  { key: "type", label: "Page type" },
  { key: "toFill", label: "To fill", format: "number" },
  { key: "volume", label: "Searches a month", format: "number" },
  // Without plans a credit is a cent, so the column is the dollars spent.
  rules.hasPlans ? { key: "credits", label: "Credits spent", format: "number" } : { key: "credits", label: "Spent", format: "usd" },
  { key: "createdAt", label: "Created", format: "date" },
];

export default async function BriefsPage() {
  const project = await getCurrentProject();
  const header = (
    <>
      <PageHeader
        title="Keyword research"
        description={project ? `Content briefs for ${project.name}: what a page for one keyword should cover, with the source and date of every figure. Never the article itself.` : undefined}
        actions={project ? <ButtonLink href="/keywords/briefs/new">New brief</ButtonLink> : undefined}
      />
      <ModuleTabs tabs={keywordTabs("", project?.locationCode ?? 2840)} />
    </>
  );
  if (!project) {
    return (
      <>
        {header}
        <NoProject />
      </>
    );
  }
  const briefs = await listBriefs(projectScope(project));
  const rows = briefs.map((b) => ({
    id: b.id,
    keyword: b.keyword,
    type: PAGE_TYPE_LABEL[b.pageType] ?? b.pageType,
    toFill: toFill(b.brief, b.fill).length,
    volume: b.brief.target.volume,
    credits: rules.hasPlans ? b.creditsSpent : b.creditsSpent * rules.creditUsd,
    createdAt: b.createdAt.toISOString(),
  }));

  return (
    <>
      {header}
      {rows.length ? (
        <Section title="Saved briefs" className="mt-6" description="To fill counts what only you can add: the angle the top 3 miss, your own numbers, tests, screenshots, prices and drawbacks.">
          <DataTable filename="content-briefs" initialSort={{ key: "createdAt", desc: true }} columns={COLUMNS} rows={rows} />
        </Section>
      ) : (
        <div className="mt-6">
          <EmptyState
            title="No briefs yet"
            description={`Start one from a keyword: its top 10, questions, what the top 3 cover, a headings-only outline and internal links. Saved lookups are free; anything else shows its price${rules.hasPlans ? ` in ${rules.researchNoun}` : ""} first.`}
            action={<ButtonLink href="/keywords/briefs/new">New brief</ButtonLink>}
          />
        </div>
      )}
    </>
  );
}
