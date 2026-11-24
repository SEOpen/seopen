import { Callout } from "@/components/ui/callout";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { formatDateTime, formatDateTimeZoned, formatNumber, formatUsd } from "@/lib/format";
import { stopActiveCrawl } from "../actions";
import type { CrawlRow } from "../queries";
import { AutoRefresh } from "./auto-refresh";

function headline(crawl: CrawlRow): string {
  switch (crawl.status) {
    case "queued":
      return "Crawl queued, waiting to start…";
    case "posting":
      return "Starting the crawl…";
    case "importing":
      return "Crawl finished. Copying results and scoring issues…";
    default:
      return crawl.pagesCrawled ? `Crawl running: ${formatNumber(crawl.pagesCrawled)} of up to ${formatNumber(crawl.maxPages)} pages` : "Crawl sent. Waiting for it to start…";
  }
}

/** A crawl in flight: how far along, kept fresh while it runs, and the way to stop it. The cost line is the owner's. */
export function CrawlProgress({ crawl, showCost, timeZone }: { crawl: CrawlRow; showCost: boolean; timeZone: string }) {
  const done = Math.max(3, Math.min(100, (crawl.pagesCrawled / crawl.maxPages) * 100));
  return (
    <div className="mb-5">
      <AutoRefresh seconds={10} />
      <Callout title={headline(crawl)}>
        <div role="progressbar" aria-label="Pages crawled" aria-valuemin={0} aria-valuemax={crawl.maxPages} aria-valuenow={crawl.pagesCrawled} className="mt-2 h-1 max-w-[69ch] bg-surface-2">
          <div className="h-full bg-secondary" style={{ width: `${done}%` }} />
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p className="text-xs text-muted">
            Started {formatDateTimeZoned(crawl.startedAt ?? crawl.createdAt, timeZone)} · {formatNumber(crawl.pagesInQueue)} in queue
            {showCost && <> · up to {formatUsd(crawl.estimatedCostUsd)}</>}
            {crawl.lastPolledAt && <> · checked {formatDateTime(crawl.lastPolledAt, timeZone)}</>}
          </p>
          {crawl.status !== "importing" && (
            <form action={stopActiveCrawl}>
              <ConfirmSubmit question="Stop this crawl and keep what it found so far?" confirmLabel="Stop crawl">
                Stop and keep results
              </ConfirmSubmit>
            </form>
          )}
        </div>
      </Callout>
    </div>
  );
}
