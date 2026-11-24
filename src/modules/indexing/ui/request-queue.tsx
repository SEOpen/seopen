import type { ReactNode } from "react";
import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { formatDate, formatDateTime } from "@/lib/format";
import { plainState } from "@/modules/google/brief";
import { markRequested } from "../actions";
import type { IndexingPage, LinkHint } from "../data";
import { REQUESTS_PER_DAY } from "../state";

const pathOf = (url: string) => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
};

const shortUrl = (url: string) => url.replace(/^https?:\/\//, "");

function PageLine({ page }: { page: IndexingPage }) {
  return (
    <a href={page.url} target="_blank" rel="noreferrer" className="data block truncate text-fg hover:underline" title={page.url}>
      {shortUrl(page.url)}
    </a>
  );
}

function Hint({ hint }: { hint: LinkHint | undefined }) {
  if (!hint) return null;
  const parts: ReactNode[] = [];
  if (hint.linksIn !== null) parts.push(hint.linksIn === 0 ? "No internal links to it in the last audit" : `${hint.linksIn} internal ${hint.linksIn === 1 ? "link" : "links"} to it in the last audit`);
  if (hint.from.length) {
    parts.push(
      <span key="from">
        Link to it from{" "}
        {hint.from.map((u, i) => (
          <span key={u}>
            {i > 0 && ", "}
            <a href={u} target="_blank" rel="noreferrer" className="data text-secondary hover:underline">
              {pathOf(u)}
            </a>
          </span>
        ))}
      </span>,
    );
  }
  if (!parts.length) return null;
  return (
    <p className="text-xs text-muted [overflow-wrap:anywhere]">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && " · "}
          {p}
        </span>
      ))}
    </p>
  );
}

function OpenInSearchConsole({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a href={href} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "secondary", size: "sm" })}>
      Open in Search Console
    </a>
  );
}

/**
 * The pages to press Request Indexing on, best first, each with the Search Console link and a
 * Mark requested button, plus the day's count against Search Console's limit. SEOpen can't press
 * the button itself (no API offers it); marking a page moves it to Requested, rechecked the next day.
 */
export function RequestQueue({ projectId, pages, hints, requestedToday, timeZone }: { projectId: number; pages: IndexingPage[]; hints: Map<string, LinkHint>; requestedToday: number; timeZone: string }) {
  const full = requestedToday >= REQUESTS_PER_DAY;
  return (
    <Section
      title="Request indexing"
      description={`Open each page in Search Console, press Request Indexing, then mark it here. Search Console allows about ${REQUESTS_PER_DAY} a day, so the pages a request helps most come first. Links from pages Google already indexed help these pages too, with no daily limit.`}
      actions={<Badge tone={full ? "warn" : "neutral"}>{`${requestedToday} of about ${REQUESTS_PER_DAY} in the last 24 hours`}</Badge>}
    >
      {!pages.length ? (
        <p className="text-sm text-secondary">Nothing to request right now.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line border-y border-line">
          {pages.map((p) => (
            <li key={p.url} className="flex flex-col gap-3 py-3 @2xl/main:flex-row @2xl/main:items-center @2xl/main:gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <PageLine page={p} />
                <p className="text-xs text-secondary">
                  {p.coverage ? plainState(p.coverage) : p.label}
                  {p.requestedAt && ` · requested ${formatDate(p.requestedAt, timeZone)}, still not indexed`}
                </p>
                <Hint hint={hints.get(p.url)} />
              </div>
              <div className="flex shrink-0 flex-wrap items-start gap-2">
                <OpenInSearchConsole href={p.inspectionLink} />
                <ActionForm action={markRequested.bind(null, projectId, p.url, true)}>
                  <Button type="submit" size="sm">
                    Mark requested
                  </Button>
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Pages marked requested in the last week that Google hasn't indexed yet, with Undo. */
export function RequestedList({ projectId, pages, timeZone }: { projectId: number; pages: IndexingPage[]; timeZone: string }) {
  if (!pages.length) return null;
  return (
    <Section title="Requested" description="Each is inspected again a day after you mark it, and moves to Now indexed once Google has it. A page still out after a week goes back to the list above.">
      <ul className="flex flex-col divide-y divide-line border-y border-line">
        {pages.map((p) => {
          const checkedSince = p.inspectedAt && p.requestedAt && p.inspectedAt > p.requestedAt;
          return (
            <li key={p.url} className="flex flex-col gap-3 py-3 @2xl/main:flex-row @2xl/main:items-center @2xl/main:gap-6">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <PageLine page={p} />
                <p className="text-xs text-secondary">
                  Requested {formatDateTime(p.requestedAt, timeZone)} ·{" "}
                  {checkedSince ? `Google said ${p.coverage ? plainState(p.coverage).toLowerCase() : "not indexed"} on ${formatDateTime(p.inspectedAt, timeZone)}` : "Google is asked again about a day after the request"}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-start gap-2">
                <OpenInSearchConsole href={p.inspectionLink} />
                <ActionForm action={markRequested.bind(null, projectId, p.url, false)}>
                  <Button type="submit" variant="ghost" size="sm">
                    Undo
                  </Button>
                </ActionForm>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
