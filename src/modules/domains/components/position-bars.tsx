import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Bucket } from "../transform";

const PAGE_ONE = new Set(["1–3", "4–10"]);

/** Keywords per position band: ranked bars with no track, the value at the tip, page one stronger and the rest quieter. */
export function PositionBars({ items }: { items: Bucket[] }) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {items.map((i) => {
        const ratio = i.count / max;
        return (
          <li key={i.label} className="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-3">
            <span className="text-muted">{i.label}</span>
            <span className="flex items-center gap-2">
              {/* Leaves 4rem on the longest bar, so its number always fits at the tip. */}
              <span className={cn("block h-2 shrink-0 rounded-sm", PAGE_ONE.has(i.label) ? "bg-secondary" : "bg-line-strong")} style={{ width: `calc(${ratio * 100}% - ${ratio * 4}rem)` }} />
              <span className="data" title={`${i.count} keywords`}>
                {formatNumber(i.count)}
              </span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
