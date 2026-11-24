import { NoProject } from "@/components/require-project";
import { ActionForm } from "@/components/ui/action-form";
import { BackLink } from "@/components/ui/back-link";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { locationName } from "@/lib/dataforseo/locations";
import { OpError } from "@/lib/ops";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { createBrief } from "@/modules/content-briefs/actions";
import { CreateBriefButton } from "@/modules/content-briefs/components/create-button";
import { splitKeywords } from "@/modules/content-briefs/href";
import { createBriefOp, type CreateOutcome } from "@/modules/content-briefs/ops";
import { guessPageType } from "@/modules/content-briefs/templates";
import { PAGE_TYPE_LABEL, PAGE_TYPES, type PageType } from "@/modules/content-briefs/types";
import { keywordTabs, param } from "@/modules/keywords/market";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "New content brief" };

const FROM: Record<string, string> = {
  "ai-action": "From AI visibility → Actions: no page of yours is cited for this prompt.",
  keywords: "From Keyword research.",
};

const HELP: Record<PageType, string> = {
  guide: "An article that answers the search.",
  vs: "Two things side by side. Y defaults to your first tracked competitor.",
  alternatives: "5 to 8 options, never your own site first, one real drawback each.",
  best: "A short list of picks for one kind of buyer.",
  pricing: "What something costs, every price with the date it was checked.",
};

export default async function NewBriefPage({ searchParams }: PageProps<"/keywords/briefs/new">) {
  const sp = await searchParams;
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const q = (param(sp.q) ?? "").trim();
  const rawType = param(sp.type);
  const pageType: PageType = PAGE_TYPES.find((t) => t === rawType) ?? guessPageType(q);
  const x = param(sp.x) ?? "";
  const y = param(sp.y) ?? "";
  const merge = param(sp.merge) ?? "";
  const from = FROM[param(sp.from) ?? ""];

  // The price, without spending: a dry run of the same operation the button runs.
  let quote: Extract<CreateOutcome, { state: "preview" }> | null = null;
  let problem: { message: string } | null = null;
  if (q) {
    try {
      const out = await createBriefOp(projectScope(project), { userId: "", source: "app" }, { keyword: q, pageType, x: x || null, y: y || null, merged: splitKeywords(merge) }, { dryRun: true });
      if (out.state === "preview") quote = out;
    } catch (e) {
      if (!(e instanceof OpError)) throw e;
      problem = { message: e.message };
    }
  }

  return (
    <>
      <BackLink href="/keywords/briefs">Briefs</BackLink>
      <PageHeader
        title="New content brief"
        description={`What a page for one keyword should cover, from the live top 10 and keyword data in ${locationName(project.locationCode)}, and ${project.name}'s own Search Console and audit data. It never writes the article.`}
      />
      <ModuleTabs tabs={keywordTabs(q, project.locationCode)} />
      {from && <p className="mb-4 text-sm text-secondary">{from}</p>}

      <form action="/keywords/briefs/new" className="grid max-w-2xl gap-4">
        {sp.from && <input type="hidden" name="from" value={param(sp.from)} />}
        <div className="grid gap-1.5">
          <Label htmlFor="q">Main keyword</Label>
          <Input id="q" name="q" defaultValue={q} required maxLength={700} placeholder="such as how to prune roses" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="type">Page type</Label>
          <Select id="type" name="type" defaultValue={pageType}>
            {PAGE_TYPES.map((t) => (
              <option key={t} value={t}>
                {PAGE_TYPE_LABEL[t]}: {HELP[t]}
              </option>
            ))}
          </Select>
        </div>
        {pageType !== "guide" && (
          <div className="grid gap-4 @2xl/main:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="x">X</Label>
              <Input id="x" name="x" defaultValue={quote?.x ?? x} maxLength={120} placeholder="Read from the keyword when left empty" />
            </div>
            {(pageType === "vs" || pageType === "best") && (
              <div className="grid gap-1.5">
                <Label htmlFor="y">Y</Label>
                <Input id="y" name="y" defaultValue={quote?.y ?? y} maxLength={120} placeholder={pageType === "vs" ? "Your first tracked competitor when left empty" : "Who it's for"} />
              </div>
            )}
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="merge">Also target on this page (optional)</Label>
          <Textarea id="merge" name="merge" defaultValue={merge} rows={3} placeholder="One keyword per line, at most 10. Only ones a single page can answer." />
        </div>
        <div>
          <Button type="submit" variant={quote ? "secondary" : "primary"}>
            {quote ? "Update the price" : "See the price"}
          </Button>
        </div>
      </form>

      {problem && (
        <div className="mt-6 max-w-2xl">
          <Callout tone="warn" title="Can't make this brief yet" role="alert">
            {problem.message}
          </Callout>
        </div>
      )}

      {quote && (
        <Section
          title={`${PAGE_TYPE_LABEL[quote.pageType]} brief for “${quote.keyword}”`}
          description="Keyword metrics are kept 30 days and the brief's top 10 for 7 days, so lookups already made are free. Reading the top 3 pages and your own data costs nothing."
          className="max-w-2xl"
        >
          <p className="mb-3 text-sm text-secondary">
            {quote.credits ? `It costs ${rules.creditsText(quote.credits)} for the lookups that aren't saved yet.` : "Every lookup it needs is saved, so it's free."}
            {quote.merged.length ? ` Merged: ${quote.merged.join(", ")}.` : ""}
          </p>
          <ActionForm action={createBrief.bind(null, project.id, quote.credits)}>
            <input type="hidden" name="q" value={quote.keyword} />
            <input type="hidden" name="type" value={quote.pageType} />
            <input type="hidden" name="x" value={quote.x ?? ""} />
            <input type="hidden" name="y" value={quote.y ?? ""} />
            <input type="hidden" name="merge" value={quote.merged.join("\n")} />
            <CreateBriefButton credits={quote.credits} />
          </ActionForm>
        </Section>
      )}
    </>
  );
}
