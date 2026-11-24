"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { TabsPlaceholder } from "./page-skeleton";
import { docsHelpHref, edgeFade, revealLeft, tabHref } from "./tab-href";

/** A mask rather than a colour laid over the row, so it needs no background to match in either theme. The width is TAB_FADE_PX. */
const FADES =
  "data-[fade=start]:[mask-image:linear-gradient(to_right,transparent,black_24px)] data-[fade=end]:[mask-image:linear-gradient(to_left,transparent,black_24px)] data-[fade=both]:[mask-image:linear-gradient(to_right,transparent,black_24px,black_calc(100%-24px),transparent)]";

function HelpLink({ href, className }: { href: string; className: string }) {
  return (
    // The docs are on the marketing site, so a plain link in a new tab keeps the app where it was.
    <a
      href={href}
      target="_blank"
      rel="noopener"
      className={cn(
        "flex shrink-0 items-center text-xs whitespace-nowrap text-muted transition-colors duration-[120ms] ease-instrument hover:text-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    >
      How this works
    </a>
  );
}

/**
 * Link-based sub-navigation. Each tab's href is a full path; the active tab matches the pathname.
 * `helpHref` adds a quiet link: at the end of the row outside the part that scrolls, or on a phone,
 * where it would take room from the tabs, at the far end of the part that scrolls.
 */
export function Tabs({ tabs, helpHref }: { tabs: { href: string; label: string }[]; helpHref?: string | null }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  // The longest tab path that prefixes the pathname wins, so /keywords/lists/3 highlights "Lists", not "Overview".
  const activeHref = tabs
    .map((t) => t.href.split("?")[0])
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0];
  const navRef = useRef<HTMLElement>(null);

  // Sets the row's own scroll rather than calling scrollIntoView, which also moves the page when the row is off-screen, as after going back.
  useLayoutEffect(() => {
    const nav = navRef.current;
    const tab = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !tab) return;
    const left = tab.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    nav.scrollLeft = revealLeft(left, tab.offsetWidth, nav.scrollLeft, nav.clientWidth);
  }, [activeHref]);

  // Written straight to the element, so scrolling doesn't re-render the row. The tabs are watched as well, because a late font changes their widths.
  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const update = () => {
      nav.dataset.fade = edgeFade(nav.scrollLeft, nav.scrollWidth, nav.clientWidth);
    };
    update();
    nav.addEventListener("scroll", update, { passive: true });
    const resized = new ResizeObserver(update);
    resized.observe(nav);
    for (const child of Array.from(nav.children)) resized.observe(child);
    return () => {
      nav.removeEventListener("scroll", update);
      resized.disconnect();
    };
  }, [tabs.length]);

  return (
    // The inset shadow is the bottom rule, so the scroller doesn't clip the active underline. min-w-0 on both: the row has to give way in a grid or flex parent.
    <div className="mb-5 flex min-w-0 gap-4 shadow-[inset_0_-1px_0_var(--color-line)]">
      {/* Scrolls sideways on a narrow screen instead of widening the page. */}
      <nav ref={navRef} aria-label="Sections" className={cn("flex min-w-0 flex-1 scroll-px-6 gap-6 overflow-x-auto [scrollbar-width:none]", FADES)}>
        {tabs.map((t) => {
          const active = t.href.split("?")[0] === activeHref;
          return (
            <Link
              key={t.href}
              href={tabHref(t.href, search)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "shrink-0 border-b-2 py-2.5 text-sm whitespace-nowrap transition-colors duration-[120ms] ease-instrument focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                active ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
              )}
            >
              {t.label}
            </Link>
          );
        })}
        {/* Among the tabs, the underline is what says it isn't one. */}
        {helpHref && <HelpLink href={helpHref} className="underline decoration-line underline-offset-3 @2xl/main:hidden" />}
      </nav>
      {helpHref && <HelpLink href={helpHref} className="@max-2xl/main:hidden" />}
    </div>
  );
}

/** Tabs with the Suspense they need: they read the query, so the static shell can't wait for them. The row's first tab says which part of the Guide it links to. */
export function ModuleTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  return (
    <Suspense fallback={<TabsPlaceholder />}>
      <Tabs tabs={tabs} helpHref={docsHelpHref(tabs[0]?.href)} />
    </Suspense>
  );
}
