import { ApiError } from "@/components/api-error";
import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { formatDateTime } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { googleApis } from "@/modules/google/apis";
import { gscSource, sitemapFigures, sitemapsSentence } from "@/modules/google/brief";
import type { GscSitemap } from "@/modules/google/types";
import { GscBriefing, gscPropertyContext } from "@/modules/google/ui/context";
import { GscTabs } from "@/modules/google/ui/status";

export const metadata = { title: "Sitemaps · Search Console" };

export default async function SitemapsPage({ searchParams }: PageProps<"/gsc/sitemaps">) {
  const sp = await searchParams;
  const ctx = await gscPropertyContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project } = ctx;

  const timeZone = await currentTimeZone();
  let maps: GscSitemap[] = [];
  let error: unknown = null;
  try {
    maps = await (await googleApis(project.workspaceId)).gsc.sitemaps(project.gscProperty);
  } catch (e) {
    error = e;
  }

  return (
    <>
      <PageHeader title="Search Console" description={`${gscSource(project.gscProperty)} · read live from Google`} />
      <GscTabs />
      {error ? (
        <div className="mb-4">
          <ApiError error={error} />
        </div>
      ) : (
        <GscBriefing sentence={sitemapsSentence(maps)} figures={sitemapFigures(maps)} />
      )}
      {/* A failed read says nothing about how many there are, so no count and no empty table. */}
      {!error && (
        <Section title={`Submitted sitemaps (${maps.length})`} className="mt-6">
          <DataTable
            searchable={maps.length > 10}
            filename={`${project.domain}-sitemaps`}
            columns={[
              { key: "path", label: "Sitemap", format: "url" },
              { key: "kind", label: "Type", format: "badge" },
              { key: "submitted", label: "URLs", format: "number" },
              { key: "errors", label: "Errors", format: "number" },
              { key: "warnings", label: "Warnings", format: "number" },
              { key: "read", label: "Last read", data: true },
              { key: "sent", label: "Submitted", data: true },
              { key: "pending", label: "Status", format: "badge" },
            ]}
            rows={maps.map((m) => ({
              ...m,
              kind: m.isSitemapsIndex ? "Index" : m.type ? m.type.charAt(0).toUpperCase() + m.type.slice(1).toLowerCase() : "Sitemap",
              read: m.lastDownloaded ? formatDateTime(m.lastDownloaded, timeZone) : "Never",
              sent: m.lastSubmitted ? formatDateTime(m.lastSubmitted, timeZone) : "–",
              pending: m.isPending ? "Pending" : m.errors ? "Errors" : "OK",
            }))}
          />
        </Section>
      )}
      <p className="mt-4 text-sm text-muted">
        To add a sitemap, submit it in{" "}
        <a target="_blank" rel="noreferrer" className="text-accent underline-offset-3 hover:underline" href={`https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(project.gscProperty)}`}>
          Search Console
        </a>
        . SEOpen reads Search Console without write access.
      </p>
    </>
  );
}
