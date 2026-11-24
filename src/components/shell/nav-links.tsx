import {
  Activity,
  BarChart3,
  Bell,
  BookOpen,
  ClipboardList,
  Coins,
  FileSearch,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  MapPin,
  MessageSquareQuote,
  Plug,
  Settings,
  Telescope,
  TrendingUp,
  UserRoundPlus,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { NavGroup, NavIconKey } from "./nav-model";

export const ICONS: Record<NavIconKey, LucideIcon> = {
  all: LayoutGrid,
  overview: LayoutDashboard,
  rank: TrendingUp,
  audit: ClipboardList,
  gsc: FileSearch,
  ga4: BarChart3,
  ai: MessageSquareQuote,
  mcp: Plug,
  fixes: Wrench,
  local: MapPin,
  backlinks: Link2,
  settings: Settings,
  alerts: Bell,
  keywords: Telescope,
  domains: Globe,
  workspaces: LayoutGrid,
  users: Users,
  waitlist: UserRoundPlus,
  health: Activity,
  spend: Coins,
  runbook: BookOpen,
};

export const focusRing = "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";
export const rowClass = cn("flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-[120ms] ease-instrument rail:justify-center rail:px-0", focusRing);
export const idle = "text-secondary hover:bg-tile hover:text-fg";
/** The selected row: one step above hover, with the blue square. */
export const current = "bg-surface-2 font-medium text-fg";
/** An icon only on the 56px rail, where it is the row's one label. The full sidebar is words, as the kit draws it. */
export const railIcon = "hidden size-4 shrink-0 rail:block";

/** The small blue square on the selected row. The rail has its blue icon instead. */
export function RowMark({ active }: { active?: boolean }) {
  return active ? <span aria-hidden className="size-1.5 shrink-0 rounded-[1px] bg-accent-fill rail:hidden" /> : null;
}

/** The sidebar's rows. In their own file so the marketing site's app mockups draw the same rows without the sidebar's client code. */
export function NavLinks({ groups, label = "Main", onOpen }: { groups: NavGroup[]; label?: string; /** Rows become buttons that call this, not links: the site's working demo. */ onOpen?: (item: NavGroup["items"][number]) => void }) {
  return (
    // Tighter from md, so the whole column fits a laptop window about 900px tall; the phone drawer keeps the
    // room for thumbs.
    // A labelled group is a section: its heading, then its rows on a hairline guide. The rail drops both.
    <nav aria-label={label} className="flex flex-col gap-5 md:gap-3">
      {groups.map((g, i) => (
        <div key={g.label ?? i}>
          {g.label && (
            <div className="mb-1 flex h-5 items-center px-2 text-xs font-medium text-muted rail:mb-0 rail:h-2 rail:px-0">
              <span className="rail:sr-only">{g.label}</span>
              <span aria-hidden className="hidden h-px w-full bg-line-soft rail:block" />
            </div>
          )}
          <ul className={cn("flex flex-col gap-0.5 md:gap-px", g.label && "ml-3 border-l border-tick pl-1.5 rail:ml-0 rail:border-l-0 rail:pl-0")}>
            {g.items.map((item) => {
              const Icon = ICONS[item.icon];
              if (onOpen) {
                return (
                  <li key={item.label}>
                    <button type="button" onClick={() => onOpen(item)} title={item.label} aria-current={item.active ? "page" : undefined} className={cn(rowClass, "w-full cursor-pointer text-left", item.active ? current : idle)}>
                      <RowMark active={item.active} />
                      <Icon aria-hidden className={cn(railIcon, item.active && "text-accent")} strokeWidth={1.5} />
                      <span className="min-w-0 truncate rail:sr-only">{item.label}</span>
                    </button>
                  </li>
                );
              }
              return (
                <li key={item.label}>
                  {/* prefetch off: opening /projects/<id> switches the project cookie, so a prefetch must never reach it. */}
                  <Link href={item.href} prefetch={false} title={item.label} aria-current={item.active ? "page" : undefined} className={cn(rowClass, item.active ? current : idle)}>
                    <RowMark active={item.active} />
                    <Icon aria-hidden className={cn(railIcon, item.active && "text-accent")} strokeWidth={1.5} />
                    <span className="min-w-0 truncate rail:sr-only">{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
