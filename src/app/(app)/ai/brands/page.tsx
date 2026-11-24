import { asc } from "drizzle-orm";
import { X } from "lucide-react";
import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { FigureView } from "@/components/ui/figure";
import { Input, Select } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { db } from "@/db";
import { aiBrandAliases } from "@/db/schema/ai";
import { getCurrentProject } from "@/lib/projects";
import { inScope, projectScope } from "@/lib/workspace";
import { formatNumber } from "@/lib/format";
import { ActionForm } from "@/components/ui/action-form";
import { addAlias, addSuggestedCompetitor, removeAlias } from "@/modules/ai/actions";
import { brandsFigures, brandsSentence } from "@/modules/ai/brief";
import { AiTabs } from "@/modules/ai/components/chrome";
import { getSuggestedCompetitors } from "@/modules/ai/data";
import { loadBrands } from "@/modules/ai/run";

export const metadata = { title: "AI brands" };

export default async function AiBrandsPage() {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const [brands, aliases] = await Promise.all([
    loadBrands(project),
    db.select().from(aiBrandAliases).where(inScope(aiBrandAliases, projectScope(project))).orderBy(asc(aiBrandAliases.alias)),
  ]);
  const { answers, suggestions } = await getSuggestedCompetitors(project, brands);
  const counts = { competitors: brands.length - 1, aliases: aliases.length, answers, suggestions: suggestions.length };

  return (
    <>
      <PageHeader
        title="AI visibility"
        description="The names SEOpen looks for in AI answers. Each brand matches its domain name in any capitalisation, with or without a hyphen or space; your own brand also matches the project’s name."
        actions={
          <ButtonLink href={`/projects/${project.id}/settings`} prefetch={false} variant="secondary">
            Edit competitors
          </ButtonLink>
        }
      />
      <AiTabs />
      <Briefing sentence={brandsSentence(counts)}>
        {brandsFigures(counts).map((f) => (
          <FigureView key={f.id} data={f} />
        ))}
      </Briefing>

      <div className="module-rail">
        <Section title="Tracked brands" description="Your project first, then its competitors" className="mt-6">
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th scope="col" className="h-9 px-3 text-left font-medium">
                    Brand
                  </th>
                  <th scope="col" className="h-9 px-3 text-left font-medium">
                    Names and aliases
                  </th>
                  <th scope="col" className="h-9 px-3 text-left font-medium">
                    Cited domains
                  </th>
                </tr>
              </thead>
              <tbody>
                {brands.map((b) => (
                  <tr key={b.domain} className="border-t border-line-soft align-top">
                    <td className={`px-3 py-2.5 ${b.own ? "font-medium" : ""}`}>
                      {b.name}
                      <div className="text-xs font-normal text-muted">{b.own ? "you" : "competitor"}</div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span>{b.names.join(", ")}</span>
                        {aliases
                          .filter((a) => a.domain === b.domain)
                          .map((a) => (
                            <form key={a.id} action={removeAlias.bind(null, project.id, a.id)}>
                              <button
                                aria-label={`Remove alias ${a.alias}`}
                                title="Remove alias"
                                className="inline-flex h-5 items-center gap-1 rounded-sm bg-surface-2 px-[7px] text-xs whitespace-nowrap text-secondary hover:text-bad focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                              >
                                {a.alias}
                                <X aria-hidden className="size-3" strokeWidth={1.5} />
                              </button>
                            </form>
                          ))}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 [overflow-wrap:anywhere]">{b.domains.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
        <Card className="min-w-0 self-start @5xl/main:mt-6">
          <CardHeader title="Add an alias" description="A product name or another domain the brand uses. Matching ignores case, and stored answers are re-checked right away, at no cost." />
          <CardBody>
            <ActionForm action={addAlias.bind(null, project.id)} className="grid grid-cols-1 gap-3">
              <Select name="domain" aria-label="Brand" className="w-full min-w-0">
                {brands.map((b) => (
                  <option key={b.domain} value={b.domain}>
                    {b.name} ({b.domain})
                  </option>
                ))}
              </Select>
              <Input name="alias" required minLength={2} maxLength={80} placeholder="Alias or domain" aria-label="Alias" />
              <Button type="submit">Add alias</Button>
            </ActionForm>
          </CardBody>
        </Card>
      </div>

      <Section
        title="Suggested competitors"
        description="Sites cited in two or more of the latest answers that aren’t you or a tracked competitor. Directories, review sites, social networks, marketplaces and app stores are left out. Adding one tracks it everywhere competitors are used and re-checks stored answers right away, at no cost."
      >
        {suggestions.length ? (
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th scope="col" className="h-9 px-3 text-left font-medium">
                    Site
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-medium">
                    Answers citing it
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-medium">
                    Prompts
                  </th>
                  <th scope="col" className="h-9 px-3" aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {suggestions.map((s) => (
                  <tr key={s.domain} className="border-t border-line-soft">
                    <td className="px-3 py-2.5 [overflow-wrap:anywhere]">
                      <a href={`https://${s.domain}`} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
                        {s.domain}
                      </a>
                    </td>
                    <td className="data px-3 py-2.5 text-right">
                      {formatNumber(s.answers)} <span className="text-muted">of {formatNumber(answers)}</span>
                    </td>
                    <td className="data px-3 py-2.5 text-right">{formatNumber(s.prompts)}</td>
                    <td className="px-3 py-1.5 text-right">
                      <ActionForm action={addSuggestedCompetitor.bind(null, project.id, s.domain)} align="end">
                        <Button type="submit" size="sm" variant="secondary" aria-label={`Add ${s.domain} as a competitor`}>
                          Add
                        </Button>
                      </ActionForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-secondary">{answers ? "No untracked site is cited in two or more answers yet." : "Suggestions appear once tracked prompts have been answered."}</p>
        )}
      </Section>
    </>
  );
}
