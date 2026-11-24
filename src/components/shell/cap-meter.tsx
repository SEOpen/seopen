import { Coins, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { usageSummary } from "@/lib/billing/spend";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";
import { workspaceScope } from "@/lib/workspace/current";

const frame =
  "flex min-h-8 flex-col justify-center gap-1 rounded-md px-2 py-1.5 hover:bg-surface-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent rail:items-center rail:px-0";

/**
 * This month's DataForSEO spend at the foot of the sidebar on a copy without plans, against the
 * workspace's monthly cap, linking to Admin › Spend where the cap is set. From 80% it turns amber with
 * a warning icon; at the cap it turns red and says so. On the rail it's the icon alone, with the same
 * words as its label.
 */
export async function CapMeter() {
  const { workspaceId } = await workspaceScope();
  const s = await usageSummary(workspaceId);
  const capped = Number.isFinite(s.ceilingUsd);
  const ratio = capped && s.ceilingUsd > 0 ? s.spentUsd / s.ceilingUsd : capped ? 1 : 0;
  const state = ratio >= 1 ? "reached" : ratio >= 0.8 ? "near" : "ok";
  const spent = formatUsd(s.spentUsd, 2);
  const label =
    `${spent} of DataForSEO spent this month` +
    (capped ? ` of this workspace's ${formatUsd(s.ceilingUsd, 2)} cap` : "") +
    (state === "reached" ? ". The cap is reached, so paid calls are blocked. Raise it in Admin, under Spend" : state === "near" ? ". Nearing the cap" : "");
  const tone = state === "reached" ? "text-bad" : state === "near" ? "text-warn" : "text-secondary";
  return (
    <Link href="/admin/spend" prefetch={false} aria-label={label} title={label} className={frame}>
      <span className={cn("flex items-center gap-1.5 text-xs rail:hidden", tone)}>
        {state !== "ok" && <TriangleAlert aria-hidden className="size-3.5 shrink-0" strokeWidth={1.5} />}
        {state === "reached" ? (
          <span className="font-medium whitespace-nowrap">Cap reached</span>
        ) : (
          <span className="min-w-0 truncate">
            <span className="data">{spent}</span> spent
          </span>
        )}
      </span>
      {capped && (
        <span aria-hidden className="block h-1 overflow-hidden rounded-sm bg-surface-2 rail:hidden">
          <span className={cn("block h-full", state === "reached" ? "bg-bad" : state === "near" ? "bg-warn" : "bg-secondary")} style={{ width: `${Math.min(100, Math.round(ratio * 100))}%` }} />
        </span>
      )}
      {state === "ok" ? (
        <Coins aria-hidden className="hidden size-4 text-secondary rail:block" strokeWidth={1.5} />
      ) : (
        <TriangleAlert aria-hidden className={cn("hidden size-4 rail:block", tone)} strokeWidth={1.5} />
      )}
    </Link>
  );
}
