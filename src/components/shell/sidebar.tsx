"use client";

import { BookOpen, ChartNoAxesColumn, ChevronUp, CircleUser, CreditCard, Menu, PanelLeftClose, PanelLeftOpen, Plus, Search, Settings, Shield, X, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ThemeToggle } from "@/components/brand/theme-toggle";
import { LogoMark, Wordmark } from "@/components/brand/wordmark";
import { projectIdFromPath } from "@/lib/project-cookie";
import type { ShellData } from "@/lib/shell";
import { isSidebarRail, setSidebarRail, subscribeSidebar } from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import { CommandPalette } from "./command-palette";
import { focusRing, idle, NavLinks, railIcon, RowMark, rowClass } from "./nav-links";
import { adminNav, adminPalette, appNav, appPalette, resolveCurrentId, type NavGroup, type PaletteGroup } from "./nav-model";
import { ProjectSelect } from "./project-select";
import { setShownProject } from "./shown-project";
import { SignOut } from "./sign-out";
import { useDismiss } from "./use-dismiss";
import { rules } from "@/plan-policy/rules";

const subscribeNothing = () => () => {};
const isMac = () => /mac|iphone|ipad/i.test(navigator.platform);

function SearchButton({ onClick }: { onClick: () => void }) {
  const mac = useSyncExternalStore(subscribeNothing, isMac, () => true);
  return (
    <button type="button" onClick={onClick} title="Search" aria-keyshortcuts={mac ? "Meta+K" : "Control+K"} className={cn(rowClass, "w-full", idle)}>
      <Search aria-hidden className={railIcon} strokeWidth={1.5} />
      <span className="min-w-0 flex-1 truncate text-left rail:sr-only">Search</span>
      <kbd aria-hidden className="shrink-0 font-mono text-xs text-muted rail:hidden">
        {mac ? "⌘K" : "Ctrl K"}
      </kbd>
    </button>
  );
}

function CollapseButton() {
  const rail = useSyncExternalStore(subscribeSidebar, isSidebarRail, () => false);
  const label = rail ? "Expand sidebar" : "Collapse sidebar";
  return (
    <button type="button" onClick={() => setSidebarRail(!rail)} aria-label={label} aria-expanded={!rail} title={label} className={cn("inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-surface-2 hover:text-fg", focusRing)}>
      <PanelLeftClose aria-hidden className="size-4 rail:hidden" strokeWidth={1.5} />
      <PanelLeftOpen aria-hidden className="hidden size-4 rail:block" strokeWidth={1.5} />
    </button>
  );
}

/**
 * The frame both the app and Admin use: a sticky column from md (232px, or a 56px rail), a slim bar
 * and a drawer below it. Only the nav list scrolls, so the switcher and the account stay in reach,
 * and popovers aren't clipped because neither of those sits in the scroller.
 */
function SidebarFrame({ pathname, home, top, groups, footer, palette, mobileLabel }: { pathname: string; home: string; top?: ReactNode; groups: NavGroup[]; footer: ReactNode; palette: PaletteGroup[]; mobileLabel?: ReactNode }) {
  // Open only while the path it was opened on is current, so any navigation closes it without an effect.
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const drawerOpen = drawerOn === pathname;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const drawerRef = useRef<HTMLDialogElement>(null);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const navScroller = useRef<HTMLDivElement>(null);
  const firstPath = useRef(true);

  // On a short window the active row can sit under the foot. On load it's set straight, so nothing
  // glides as the page opens; `nearest` leaves a row that's already showing where it is. Below md the
  // column has no box, so this does nothing.
  useEffect(() => {
    const instant = firstPath.current || matchMedia("(prefers-reduced-motion: reduce)").matches;
    firstPath.current = false;
    navScroller.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: "nearest", behavior: instant ? "instant" : "smooth" });
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setDrawerOn(null);
        setPaletteOpen((o) => !o);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const d = drawerRef.current;
    if (!d) return;
    if (drawerOpen && !d.open) d.showModal();
    if (!drawerOpen && d.open) d.close();
  }, [drawerOpen]);

  // Past md the drawer is hidden, and an open modal would leave the page behind it inert.
  useEffect(() => {
    const wide = matchMedia("(min-width: 48rem)");
    const onChange = () => {
      if (wide.matches) setDrawerOn(null);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, []);

  return (
    <>
      <div className="slate-chrome sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-line bg-window px-3 md:hidden">
        <button type="button" aria-label="Menu" aria-expanded={drawerOpen} onClick={() => setDrawerOn(pathname)} className={cn("relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-secondary after:absolute after:-inset-1.5 hover:bg-surface-2 hover:text-fg", focusRing)}>
          <Menu aria-hidden className="size-4" strokeWidth={1.5} />
        </button>
        <Link href={home} prefetch={false} aria-label="SEOpen home" className="rounded-sm text-fg">
          <LogoMark size={20} />
        </Link>
        <div className="min-w-0 flex-1 truncate text-sm font-medium">{mobileLabel}</div>
        <button type="button" aria-label="Search" onClick={openPalette} className={cn("relative inline-flex size-8 shrink-0 items-center justify-center rounded-md text-secondary after:absolute after:-inset-1.5 hover:bg-surface-2 hover:text-fg", focusRing)}>
          <Search aria-hidden className="size-4" strokeWidth={1.5} />
        </button>
      </div>

      <aside className="slate-chrome sticky top-0 z-30 hidden h-dvh w-[232px] shrink-0 flex-col border-r border-line bg-window md:flex rail:w-14">
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-4 rail:h-auto rail:flex-col rail:px-0 rail:pt-3 rail:pb-2">
          <Link href={home} prefetch={false} aria-label="SEOpen home" className={cn("rounded-sm", focusRing)}>
            <Wordmark size={20} className="rail:hidden" />
            <LogoMark size={20} className="hidden rail:block" />
          </Link>
          <CollapseButton />
        </div>
        <div className="flex flex-col gap-1 px-3 pb-3 rail:px-2">
          {top}
          <SearchButton onClick={openPalette} />
        </div>
        <div ref={navScroller} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 [scrollbar-width:thin] rail:px-2 rail:[scrollbar-width:none]">
          <NavLinks groups={groups} />
        </div>
        <div className="flex flex-col gap-0.5 border-t border-line px-3 py-1.5 rail:px-2">{footer}</div>
      </aside>

      <dialog
        ref={drawerRef}
        aria-label="Menu"
        onClose={() => setDrawerOn(null)}
        onClick={(e) => {
          if (e.target === drawerRef.current || (e.target as HTMLElement).closest("a")) setDrawerOn(null);
        }}
        className="slate-chrome fixed inset-y-0 left-0 m-0 h-dvh max-h-none w-[min(18rem,85vw)] max-w-none border-r border-line bg-window p-0 text-fg backdrop:bg-(--scrim) md:hidden"
      >
        {drawerOpen && (
          <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
              <Wordmark size={20} />
              <button type="button" aria-label="Close menu" onClick={() => setDrawerOn(null)} className={cn("relative inline-flex size-8 items-center justify-center rounded-md text-muted after:absolute after:-inset-1.5 hover:bg-surface-2 hover:text-fg", focusRing)}>
                <X aria-hidden className="size-4" strokeWidth={1.5} />
              </button>
            </div>
            {top && <div className="px-3 pb-2">{top}</div>}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              <NavLinks groups={groups} />
            </div>
            <div className="flex flex-col gap-1 border-t border-line px-3 py-2">{footer}</div>
          </div>
        )}
      </dialog>

      <CommandPalette open={paletteOpen} onClose={closePalette} groups={palette} />
    </>
  );
}

function AccountMenu({ children, email }: { children: ReactNode; email?: string }) {
  const pathname = usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpenOn(null), []);
  useDismiss(open, close, root, button);
  return (
    <div
      ref={root}
      className="relative"
      onBlur={(e) => {
        if (e.relatedTarget && !root.current?.contains(e.relatedTarget as Node)) close();
      }}
    >
      <button ref={button} type="button" aria-expanded={open} title="Account" onClick={() => setOpenOn(open ? null : pathname)} className={cn(rowClass, "w-full", open ? "bg-surface-2 text-fg" : idle)}>
        <CircleUser aria-hidden className={railIcon} strokeWidth={1.5} />
        <span className="min-w-0 flex-1 truncate text-left rail:sr-only">Account</span>
        <ChevronUp aria-hidden className={cn("size-3.5 shrink-0 text-muted rail:hidden", !open && "rotate-180")} strokeWidth={1.5} />
      </button>
      {open && (
        <div
          onClick={(e) => {
            if ((e.target as HTMLElement).closest("a")) close();
          }}
          className="absolute bottom-full left-0 z-50 mb-1.5 w-60 rounded-lg border border-control-edge bg-surface p-1 rail:bottom-0 rail:left-full rail:mb-0 rail:ml-2"
        >
          {email && <p className="truncate px-2.5 py-1.5 text-xs text-muted">{email}</p>}
          {children}
          <div className="mt-1 flex items-center justify-between gap-3 border-t border-line-soft px-2.5 pt-2 pb-1">
            <span className="text-xs text-muted">Theme</span>
            <ThemeToggle />
          </div>
          <SignOut className="mt-1 border-t border-line-soft pt-1" />
        </div>
      )}
    </div>
  );
}

function MenuLink({ href, icon: Icon, children }: { href: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <Link href={href} prefetch={false} className={cn("flex items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-sm text-secondary hover:bg-surface-2 hover:text-fg", focusRing)}>
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
      {children}
    </Link>
  );
}

/** The docs, on the marketing site: a plain link in a new tab, so the app stays where it was. */
function DocsLink() {
  return (
    <a href="/docs" target="_blank" rel="noopener" title="Docs" className={cn(rowClass, idle)}>
      <RowMark active={false} />
      <BookOpen aria-hidden className={railIcon} strokeWidth={1.5} />
      <span className="rail:sr-only">Docs</span>
    </a>
  );
}

/** The app's sidebar. Reads the shell's one promise, so it needs the Suspense the layout gives it. */
export function AppSidebar({ shell, meter }: { shell: Promise<ShellData>; meter: ReactNode }) {
  const data = use(shell);
  const pathname = usePathname();
  const pathId = projectIdFromPath(pathname);
  const ids = data.projects.map((p) => p.id);
  const pathIsLive = pathId != null && ids.includes(Number(pathId));

  // The layout doesn't re-render on a client navigation, so `data.currentId` goes stale when a URL or
  // another tab moves the cookie. Keep the last project a URL named, so leaving /projects/12 for /rank
  // shows no flash of the old name, and ask the server after each navigation.
  const [known, setKnown] = useState<string | null>(null);
  if (pathIsLive && pathId !== known) setKnown(pathId);
  const currentId = resolveCurrentId(ids, { path: pathIsLive ? pathId : null, known, server: data.currentId });

  useEffect(() => setShownProject(currentId), [currentId]);

  useEffect(() => {
    if (pathId) return;
    const request = new AbortController();
    fetch("/api/projects/current", { signal: request.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { id: number | null } | null) => {
        if (body?.id != null) setKnown(String(body.id));
      })
      // An aborted or failed check leaves the last known project showing; the next navigation asks again.
      .catch(() => {});
    return () => request.abort();
  }, [pathname, pathId]);

  const groups = appNav({ count: ids.length, currentId, pathname });
  const current = data.projects.find((p) => p.id === currentId);

  return (
    <SidebarFrame
      pathname={pathname}
      home="/"
      groups={groups}
      palette={appPalette({ projects: data.projects, owner: data.owner, currentId })}
      mobileLabel={current?.name}
      top={
        ids.length ? (
          <ProjectSelect projects={data.projects} currentId={currentId} archived={data.archived} onSwitched={(id) => setKnown(String(id))} />
        ) : (
          <Link href="/projects/new" prefetch={false} title="Add your first project" className={cn(rowClass, "font-medium text-accent hover:bg-surface-2")}>
            <Plus aria-hidden className={railIcon} strokeWidth={1.5} />
            <span className="rail:sr-only">Add your first project</span>
          </Link>
        )
      }
      footer={
        <>
          <DocsLink />
          {meter}
          <AccountMenu email={data.email}>
            <MenuLink href="/settings" icon={Settings}>
              Workspace settings
            </MenuLink>
            {rules.plansHref && (
              <MenuLink href={rules.plansHref} icon={CreditCard}>
                Billing
              </MenuLink>
            )}
            {data.owner && (
              <MenuLink href="/admin" icon={Shield}>
                Admin
              </MenuLink>
            )}
          </AccountMenu>
        </>
      }
    />
  );
}

/**
 * Every label in place while the promise resolves, so nothing shifts. Links that name no project. It
 * must not read the pathname, which suspends on a dynamic route, or the fallback itself would wait.
 */
export function AppSidebarFallback() {
  return (
    <SidebarFrame
      pathname=""
      home="/"
      groups={appNav({ count: null, currentId: null, pathname: "" })}
      palette={appPalette({ projects: [], owner: false })}
      top={<div className="h-9 rounded-md bg-surface-2" />}
      footer={<DocsLink />}
    />
  );
}

/** Admin's labels while the pathname is unknown. */
export function AdminSidebarFallback() {
  return <SidebarFrame pathname="" home="/admin" groups={adminNav("")} palette={adminPalette()} mobileLabel="Admin" footer={<div className="h-8" />} />;
}

/** Admin's sidebar: its own pages, and the way back to the app. */
export function AdminSidebar({ email }: { email: ReactNode }) {
  const pathname = usePathname();
  return (
    <SidebarFrame
      pathname={pathname}
      home="/admin"
      groups={adminNav(pathname)}
      palette={adminPalette()}
      mobileLabel="Admin"
      footer={
        <>
          <Link href="/" prefetch={false} title="Open the app" className={cn(rowClass, idle)}>
            <ChartNoAxesColumn aria-hidden className={railIcon} strokeWidth={1.5} />
            <span className="rail:sr-only">Open the app</span>
          </Link>
          <AccountMenu>{email}</AccountMenu>
        </>
      }
    />
  );
}
