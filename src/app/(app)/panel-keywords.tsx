import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Delta } from "@/components/ui/delta";
import { PositionGauge } from "@/components/ui/gauge";
import { formatNumber, formatRate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NotConfirmedBadge } from "@/modules/rank/components/not-confirmed";
import type { PanelKeywords } from "./dashboard-panel";

/** The project's keywords: where each sits on the 1–20 scale, how it moved, and what it brought in. A column empty or zero in every row isn't drawn. */
export function PanelKeywordsTable({ data, className, headingAs: Heading = "h2" }: { data: PanelKeywords; className?: string; headingAs?: "h2" | "div" }) {
  const more = data.total - data.rows.length;
  const hasClicks = data.rows.some((r) => r.clicks);
  const hasCtr = data.rows.some((r) => r.ctr);
  const hasUrl = data.rows.some((r) => r.url);
  const hasDelta = data.rows.some((r) => r.delta);
  // The marker needs room beside or above the number.
  const hasUnconfirmed = data.rows.some((r) => r.notConfirmed && r.position != null);
  return (
    <section aria-labelledby="panel-keywords" className={cn("min-w-0", className)}>
      <header className="flex items-baseline justify-between gap-4">
        <Heading id="panel-keywords" className="text-[15px] font-medium">
          {data.title}
        </Heading>
        <Link href={data.href} className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-accent underline-offset-3 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent">
          {more > 0 ? `All ${formatNumber(data.total)}` : "View all"}
          <ArrowRight aria-hidden className="size-3.5" strokeWidth={1.5} />
        </Link>
      </header>
      <table className="mt-2 w-full table-fixed text-left text-sm">
        <thead className="table-head">
          <tr>
            <th scope="col" className="h-8 pr-3 font-medium">
              {data.source === "rank" ? "Keyword" : "Query"}
            </th>
            <th scope="col" className="hidden h-8 w-[20%] pr-4 font-medium @2xl/main:table-cell">
              <span className="sr-only">Position scale</span>
              <span aria-hidden>1 → 20</span>
            </th>
            <th scope="col" className={cn("h-8 pr-3 text-right font-medium", hasUnconfirmed ? "w-32" : "w-[4.5rem]")}>
              Position
            </th>
            {hasDelta && (
              <th scope="col" className="h-8 w-[4.5rem] pr-3 text-right font-medium">
                <span className="sr-only">Change over </span>
                {data.window}
              </th>
            )}
            {hasClicks && (
              <th scope="col" className="hidden h-8 w-16 pr-3 text-right font-medium sm:table-cell">
                Clicks
              </th>
            )}
            {hasCtr && (
              <th scope="col" className="hidden h-8 w-16 pr-3 text-right font-medium sm:table-cell">
                CTR
              </th>
            )}
            {hasUrl && (
              <th scope="col" className="hidden h-8 w-[22%] font-medium @5xl/main:table-cell">
                URL
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((r) => (
            <tr key={r.key} className="border-t border-line-soft">
              <td className="py-2 pr-3">
                <Link href={r.href} className="block truncate underline-offset-4 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent" title={r.keyword}>
                  {r.keyword}
                </Link>
              </td>
              <td className="hidden py-2 pr-4 @2xl/main:table-cell">{r.position != null && <PositionGauge position={r.position} previous={r.previous} />}</td>
              <td className="py-2 pr-3 text-right">
                {r.position != null ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-1.5 @2xl/main:flex-nowrap">
                    {r.notConfirmed && <NotConfirmedBadge />}
                    <span className="data text-fg">{Number.isInteger(r.position) ? r.position : r.position.toFixed(1)}</span>
                  </span>
                ) : (
                  <span className="text-xs text-muted">{r.status}</span>
                )}
              </td>
              {hasDelta && <td className="py-2 pr-3 text-right">{r.delta ? <Delta {...r.delta} /> : <span className="data text-muted">–</span>}</td>}
              {hasClicks && <td className="data hidden py-2 pr-3 text-right text-fg sm:table-cell">{r.clicks != null ? formatNumber(r.clicks) : "–"}</td>}
              {hasCtr && <td className="data hidden py-2 pr-3 text-right text-muted sm:table-cell">{r.ctr != null ? formatRate(r.ctr) : "–"}</td>}
              {hasUrl && (
                <td className="hidden py-2 @5xl/main:table-cell">
                  <span className="block truncate font-mono text-[13px] text-muted" title={r.url ?? undefined}>
                    {r.url ?? "–"}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
