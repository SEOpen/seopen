import { Trend, type TrendFormat } from "@/components/ui/trend";
import type { SeriesPoint } from "@/lib/chart-rule";

/** A reading per crawl, under its own small heading. */
export function CrawlTrend({ title, points, format = "count", height = 160 }: { title: string; points: SeriesPoint[]; format?: TrendFormat; height?: number }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-[13px] font-medium">{title}</h3>
      <Trend points={points} label={title} format={format} noun="crawl" height={height} empty={<p className="text-sm text-muted">Nothing recorded yet.</p>} />
    </div>
  );
}
