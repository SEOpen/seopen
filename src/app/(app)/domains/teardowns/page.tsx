import Link from "next/link";
import { NoProject } from "@/components/require-project";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Section } from "@/components/ui/section";
import { ModuleTabs } from "@/components/ui/tabs";
import { LOCATIONS, locationName } from "@/lib/dataforseo/locations";
import { formatDate, formatNumber } from "@/lib/format";
import { getCurrentProject } from "@/lib/projects";
import { projectScope } from "@/lib/workspace";
import { currentTimeZone } from "@/lib/workspace/current";
import { domainTabs } from "@/modules/domains/context";
import { leadSentence } from "@/modules/domains/teardown-text";
import { listTeardowns } from "@/modules/domains/teardowns";
import { rules } from "@/plan-policy/rules";

export const metadata = { title: "Teardowns" };

export default async function TeardownsPage() {
  const project = await getCurrentProject();
  const [teardowns, timeZone] = await Promise.all([project ? listTeardowns(projectScope(project)) : [], currentTimeZone()]);
  // Market only earns a mention per row when the teardowns were measured in more than one.
  const markets = new Set(teardowns.map((t) => t.locationCode));

  return (
    <>
      <PageHeader title="Domain analysis" description={project ? `Teardowns saved for ${project.name}: how a site wins its search traffic, and what to take from it.` : undefined} />
      <ModuleTabs tabs={domainTabs(project?.domain ?? "", project?.locationCode ?? LOCATIONS[0].code)} />
      {!project ? (
        <NoProject />
      ) : teardowns.length ? (
        <Section
          title={`${formatNumber(teardowns.length)} saved ${teardowns.length === 1 ? "teardown" : "teardowns"}`}
          description={markets.size === 1 ? `Newest first. Measured in ${locationName(teardowns[0].locationCode)}.` : "Newest first."}
          className="mt-6"
        >
          <ul className="max-w-5xl border-t border-line-soft">
            {teardowns.map((t) => {
              const meta = [
                `${t.moves} ${t.moves === 1 ? "move" : "moves"}`,
                markets.size > 1 ? locationName(t.locationCode) : null,
                t.creditsSpent ? rules.creditsText(t.creditsSpent, { short: true }) : null,
              ].filter(Boolean);
              return (
                <li key={t.id} className="border-b border-line-soft">
                  <Link
                    href={`/domains/teardowns/${t.id}`}
                    className="group -mx-3 grid gap-x-8 gap-y-2 rounded-md px-3 py-5 transition-colors duration-[120ms] ease-instrument hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent @3xl/main:grid-cols-[12rem_minmax(0,1fr)]"
                  >
                    <div className="min-w-0">
                      <p className="text-[17px] font-medium [overflow-wrap:anywhere] group-hover:underline group-hover:underline-offset-3">{t.domain}</p>
                      <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
                        <span className="data">{formatDate(t.createdAt, timeZone)}</span>
                        {meta.map((m) => (
                          <span key={m} className="before:mr-2 before:content-['·']">
                            {m}
                          </span>
                        ))}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="max-w-[68ch] text-[15px] leading-6 text-pretty [overflow-wrap:anywhere]">{leadSentence(t.summary, 320)}</p>
                      {t.topMove && (
                        <p className="mt-2 max-w-[68ch] text-sm leading-6 text-secondary [overflow-wrap:anywhere]">
                          <span className="font-medium text-fg">Top move: </span>
                          {t.topMove}
                        </p>
                      )}
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      ) : (
        <div className="mt-6">
          <EmptyState
            title="No teardowns yet"
            description="Ask your AI agent to tear down a competitor with SEOpen's plugin (the seopen-teardown skill). It reads the site, buys a few numbers here, and saves the moves worth copying to this page."
            action={<ButtonLink href="/agents">Connect your agent</ButtonLink>}
          />
        </div>
      )}
    </>
  );
}
