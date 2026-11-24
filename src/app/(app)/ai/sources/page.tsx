import { NoProject } from "@/components/require-project";
import { Briefing } from "@/components/ui/briefing";
import { DataTable } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { FigureView } from "@/components/ui/figure";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { SegmentedLinks } from "@/components/ui/segmented-links";
import { formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { sourcesFigures, sourcesSentence } from "@/modules/ai/brief";
import { AiTabs } from "@/modules/ai/components/chrome";
import { getSources } from "@/modules/ai/data";
import { platformLabel } from "@/modules/ai/platforms";
import { OWNERSHIP_LABEL, type Ownership } from "@/modules/ai/sources";

export const metadata = { title: "AI sources" };

const OWNERS = Object.keys(OWNERSHIP_LABEL) as Ownership[];
const PLURAL: Record<Ownership, string> = { yours: "Yours", competitor: "Competitors", third_party: "Third party" };

export default async function AiSourcesPage({ searchParams }: PageProps<"/ai/sources">) {
  const project = await getCurrentProject();
  if (!project) return <NoProject />;
  const raw = (await searchParams).owner;
  const owner = OWNERS.find((o) => o === raw) ?? null;
  const { answers, domains, urls } = await getSources(project);
  const platforms = (list: string[]) => list.map(platformLabel).join(", ");
  const count = (o: Ownership | null) => (o ? domains.filter((d) => d.ownership === o).length : domains.length);
  const shownDomains = owner ? domains.filter((d) => d.ownership === owner) : domains;
  const shownUrls = owner ? urls.filter((u) => u.ownership === owner) : urls;
  // A Gemini link that hides its site has no owner to name.
  const label = (r: { ownership: Ownership | null }) => (r.ownership ? OWNERSHIP_LABEL[r.ownership] : null);

  return (
    <>
      <PageHeader
        title="AI visibility"
        description={`Sites the AI answers cite, across the latest answer to each prompt on each platform (${formatNumber(answers)} answers). Third-party sites cited in answers that don't name you are worth reaching out to.`}
      />
      <AiTabs />
      {!domains.length ? (
        <EmptyState title="No citations yet" description="Sources appear once tracked prompts have been answered." />
      ) : (
        <>
          <Briefing sentence={sourcesSentence({ answers, domains })}>
            {sourcesFigures({ answers, domains }).map((f) => (
              <FigureView key={f.id} data={f} />
            ))}
          </Briefing>
          <SegmentedLinks
            label="Filter by owner"
            className="mt-6 max-w-full overflow-x-auto [scrollbar-width:none]"
            options={[null, ...OWNERS].map((o) => ({
              href: o ? `/ai/sources?owner=${o}` : "/ai/sources",
              label: `${o ? PLURAL[o] : "All sites"} ${formatNumber(count(o))}`,
              active: o === owner,
            }))}
          />
          <Section title="Most-cited domains" className="mt-4">
            <DataTable
              filename="ai-cited-domains"
              initialSort={{ key: "citations", desc: true }}
              columns={[
                { key: "domain", label: "Domain" },
                { key: "owner", label: "Owner", format: "badge" },
                ...(shownDomains.some((d) => d.brand) ? [{ key: "brand", label: "Brand" }] : []),
                { key: "citations", label: "Citations", format: "number" as const },
                { key: "withoutUs", label: "In answers without you", format: "number" as const },
                { key: "prompts", label: "Prompts", format: "number" as const },
                { key: "platforms", label: "Platforms" },
              ]}
              rows={shownDomains.map((d) => ({ ...d, owner: label(d), platforms: platforms(d.platforms) }))}
            />
          </Section>
          <Section title="Most-cited pages">
            <DataTable
              filename="ai-cited-pages"
              initialSort={{ key: "citations", desc: true }}
              columns={[
                { key: "url", label: "URL", format: "url", labelKey: "label" },
                ...(shownUrls.some((u) => u.title) ? [{ key: "title", label: "Title" }] : []),
                { key: "owner", label: "Owner", format: "badge" as const },
                { key: "citations", label: "Citations", format: "number" as const },
                { key: "prompts", label: "Prompts", format: "number" as const },
                { key: "platforms", label: "Platforms" },
              ]}
              rows={shownUrls.map((u) => ({ ...u, owner: label(u), platforms: platforms(u.platforms) }))}
            />
          </Section>
        </>
      )}
    </>
  );
}
