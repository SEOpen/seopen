import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { DataTable, type ColumnSpec } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { getCurrentProject } from "@/lib/projects";
import { projectScope, type ProjectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { ActionForm } from "@/components/ui/action-form";
import { createList } from "@/modules/keywords/actions";
import { listsFigures, listsSentence } from "@/modules/keywords/brief";
import { listSummaries } from "@/modules/keywords/lists";
import { keywordTabs, param, resolveMarket } from "@/modules/keywords/market";
import { columnsWithData } from "@/modules/keywords/transform";

export const metadata = { title: "Saved keyword lists" };

const COLUMNS: ColumnSpec[] = [
  { key: "name", label: "List", format: "link", href: "/keywords/lists/{id}" },
  { key: "keywords", label: "Keywords", format: "number" },
  { key: "volume", label: "Searches a month", format: "number" },
  { key: "avgKd", label: "Average difficulty", format: "number" },
  { key: "updatedAt", label: "Updated", format: "date" },
];

export default async function ListsPage({ searchParams }: PageProps<"/keywords/lists">) {
  const sp = await searchParams;
  const project = await getCurrentProject();
  const m = resolveMarket(param(sp.loc), project);
  const q = (param(sp.q) ?? "").trim().toLowerCase();

  return (
    <>
      <PageHeader title="Keyword research" description={project ? `Saved lists for ${project.name}. Adding keywords and viewing lists is free. Numbers are from when each keyword was saved.` : undefined} />
      <ModuleTabs tabs={keywordTabs(q, m.locationCode)} />
      {!project ? <NoProject /> : <Lists scope={projectScope(project)} />}
    </>
  );
}

async function Lists({ scope }: { scope: ProjectScope }) {
  const [lists, timeZone] = await Promise.all([listSummaries(scope), currentTimeZone()]);
  return (
    <>
      {lists.length > 0 && (
        <Briefing sentence={listsSentence(lists, new Date())}>
          {listsFigures(lists, timeZone).map((f) => (
            <FigureView key={f.id} data={f} />
          ))}
        </Briefing>
      )}
      <div className="module-rail mt-6">
        {lists.length ? (
          <Section title="Your lists" className="mt-0">
            <DataTable filename="keyword-lists" columns={columnsWithData(COLUMNS, lists)} rows={lists} />
          </Section>
        ) : (
          <EmptyState title="No lists yet" description="Select keywords in Ideas, Domain keywords or Keyword gap and choose “Add to list”, or create an empty list here." />
        )}
        <Card className="self-start">
          <CardHeader title="New list" />
          <CardBody>
            <ActionForm action={createList} className="flex gap-2">
              <Input name="name" placeholder="e.g. Blog topics" required maxLength={80} aria-label="List name" />
              <Button type="submit">Create</Button>
            </ActionForm>
          </CardBody>
        </Card>
      </div>
    </>
  );
}
