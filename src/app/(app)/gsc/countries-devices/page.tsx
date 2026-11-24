import { DataTable } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { projectScope } from "@/lib/workspace";
import { breakdownFigures, breakdownSentence, gscSource } from "@/modules/google/brief";
import { countryName, deviceName } from "@/modules/google/countries";
import { gscBreakdownRows } from "@/modules/google/data";
import { GscBriefing, gscContext } from "@/modules/google/ui/context";
import { describePeriods, PeriodControls } from "@/modules/google/ui/period";
import { GscTabs } from "@/modules/google/ui/status";

export const metadata = { title: "Countries & devices · Search Console" };

export default async function CountriesDevicesPage({ searchParams }: PageProps<"/gsc/countries-devices">) {
  const sp = await searchParams;
  const ctx = await gscContext(sp);
  if (!ctx.ready) return ctx.view;
  const { project, periods, choice, data } = ctx;
  const [countryRows, deviceRows] = await Promise.all([
    gscBreakdownRows(projectScope(project), "country", periods.current, periods.previous),
    gscBreakdownRows(projectScope(project), "device", periods.current, periods.previous),
  ]);
  const devices = deviceRows.map((d) => ({ ...d, name: deviceName(d.key) }));
  const countries = countryRows.map((c) => ({ ...c, name: countryName(c.key) }));
  const cmp = !!periods.previous;
  const win = { periods, compare: choice.compare, first: data.first };
  const columns = (label: string) => [
    { key: "name", label },
    { key: "clicks", label: "Clicks", format: "number" as const },
    { key: "share", label: "Share", format: "pct" as const },
    ...(cmp ? [{ key: "clicksChange", label: "Change", format: "pct" as const }] : []),
    { key: "impressions", label: "Impressions", format: "number" as const },
    { key: "ctr", label: "CTR", format: "pct" as const },
    { key: "position", label: "Position", format: "position" as const },
  ];

  return (
    <>
      <PageHeader title="Search Console" description={gscSource(project.gscProperty, data.last)} actions={<PeriodControls path="/gsc/countries-devices" sp={sp} choice={choice} />} />
      <GscTabs />
      <GscBriefing sentence={breakdownSentence(devices, countries, win)} figures={breakdownFigures(devices, countries, win)} />
      <Section title="Devices" description={describePeriods(periods)} className="mt-6">
        <DataTable searchable={false} filename={`${project.domain}-devices`} columns={columns("Device")} rows={devices} />
      </Section>
      <Section title={`Countries (${countries.length})`}>
        <DataTable filename={`${project.domain}-countries`} initialSort={{ key: "clicks", desc: true }} columns={columns("Country")} rows={countries} />
      </Section>
    </>
  );
}
