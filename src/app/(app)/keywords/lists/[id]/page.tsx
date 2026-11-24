import Link from "next/link";
import { notFound } from "next/navigation";
import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { BackLink } from "@/components/ui/back-link";
import { Briefing } from "@/components/ui/briefing";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { countOf } from "@/lib/brief";
import { locationName } from "@/lib/dataforseo/locations";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { deleteList } from "@/modules/keywords/actions";
import { listFigures, listSentence } from "@/modules/keywords/brief";
import { KeywordGrid, type GridColumn } from "@/modules/keywords/components/keyword-grid";
import { RenameList } from "@/modules/keywords/components/rename-list";
import { sourceLabel } from "@/modules/keywords/format";
import { getList, listItems } from "@/modules/keywords/lists";
import { columnsWithData, wordCount } from "@/modules/keywords/transform";

export const metadata = { title: "Keyword list" };

const COLUMNS: GridColumn[] = [
  { key: "keyword", label: "Keyword", format: "keyword" },
  { key: "intent", label: "Intent", format: "intent" },
  { key: "volume", label: "Volume", format: "number" },
  { key: "kd", label: "Difficulty", format: "kd" },
  { key: "cpc", label: "Cost per click", format: "usd" },
  { key: "words", label: "Words", format: "number" },
  { key: "market", label: "Market" },
  { key: "source", label: "Added from" },
  { key: "added", label: "Added", format: "date" },
];

export default async function ListPage({ params }: PageProps<"/keywords/lists/[id]">) {
  const id = Number((await params).id);
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const list = Number.isInteger(id) ? await getList(projectScope(project), id) : null;
  if (!list) notFound();
  const [items, timeZone] = await Promise.all([listItems(list), currentTimeZone()]);
  const rows = items.map((i) => ({
    keyword: i.keyword,
    // Not a column: the keyword's link researches it where it was saved from.
    locationCode: i.locationCode,
    intent: i.intent,
    volume: i.volume,
    kd: i.kd,
    cpc: i.cpc,
    competition: i.competition,
    words: wordCount(i.keyword),
    market: `${locationName(i.locationCode)} (${i.languageCode})`,
    source: sourceLabel(i.source),
    added: i.createdAt.toISOString(),
  }));
  const now = new Date();

  return (
    <>
      <BackLink href="/keywords/lists">Saved lists</BackLink>
      <PageHeader title={list.name} description={`${project.name}. Numbers are from when each keyword was saved.`} />
      <Briefing sentence={listSentence(items, now)}>
        {items.length > 0 && listFigures(items, now, timeZone).map((f) => <FigureView key={f.id} data={f} />)}
      </Briefing>
      {items.length ? (
        <Section title="Keywords" className="mt-6">
          <KeywordGrid rows={rows} columns={columnsWithData(COLUMNS, rows)} lists={null} removeFromListId={list.id} filename={`list-${list.name.replace(/\s+/g, "-").toLowerCase()}`} initialSort={{ key: "volume", desc: true }} />
          <p className="mt-3 text-xs text-muted">
            To track these keywords, pick this list under Add keywords in{" "}
            <Link href="/rank" className="text-accent underline-offset-3 hover:underline">
              Rankings
            </Link>
            , or use Copy all (one keyword per line) or Export CSV and paste them there.
          </p>
        </Section>
      ) : (
        <div className="mt-6">
          <EmptyState title="Nothing in this list yet" description="Select keywords in Ideas, Domain keywords or Keyword gap and choose “Add to list”." />
        </div>
      )}
      <Card className="mt-8">
        <CardHeader title="List settings" />
        <CardBody className="flex flex-wrap items-center justify-between gap-3">
          <RenameList listId={list.id} name={list.name} />
          <ActionForm action={deleteList.bind(null, list.id)} align="end">
            <ConfirmSubmit variant="danger" question={`Delete “${list.name}” and its ${countOf(items.length, "keyword")}?`} confirmLabel="Delete list">
              Delete list
            </ConfirmSubmit>
          </ActionForm>
        </CardBody>
      </Card>
    </>
  );
}
