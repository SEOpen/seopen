"use client";

import { Archive, Check, ChevronsUpDown, LoaderCircle, Plus, Search } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState, useTransition, type KeyboardEvent } from "react";
import { selectProject } from "@/app/actions/projects";
import { Badge } from "@/components/ui/badge";
import { withoutRun } from "@/components/ui/retry-button";
import type { ShellProject } from "@/lib/shell";
import { projectIdFromPath } from "@/lib/project-cookie";
import { cn } from "@/lib/utils";
import { scoreBand } from "@/modules/audit/score";
import { useDismiss } from "./use-dismiss";

/** From this many projects the menu opens with a filter box. */
const SEARCH_FROM = 7;

/**
 * Selects a project while staying on this page. The action re-renders the address it's sent from under
 * the new project, so a ?run=1 has to come off first: the same address could then mean another domain
 * or city, and it would spend with no price shown. The router sends the action only after the replace.
 */
export async function selectOnThisPage(id: number, replace: (href: string) => void) {
  const target = withoutRun(window.location.href);
  if (target) replace(target);
  await selectProject(id);
}

/**
 * The project switcher at the top of the sidebar: a button naming the current project, opening a list
 * of every project (the current one ticked, each with its site health once a crawl has finished) with
 * links to archived ones and a new one. All projects is the row just below it in the sidebar. The list
 * grows with the window and scrolls only when it runs out of room. A filter box comes first once the
 * list is long. Arrow keys move, Enter picks, Escape closes, and Tab moves on to the links below the
 * list; the menu closes once focus leaves it.
 *
 * On a page whose URL names a project (/projects/12, /projects/12/settings) switching opens the same
 * page for the new project, and the URL sets the cookie. `onSwitched` tells the sidebar, which keeps
 * the current project for this and for Overview and Settings.
 */
export function ProjectSelect({ projects, currentId, archived, onSwitched }: { projects: ShellProject[]; currentId: number | null; archived: number; onSwitched: (id: number) => void }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const pathname = usePathname();
  const pathId = projectIdFromPath(pathname);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [switchingTo, setSwitchingTo] = useState<ShellProject | null>(null);
  const [health, setHealth] = useState<Record<string, number>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-option-${i}`;

  const shown = (pending && switchingTo) || projects.find((p) => p.id === currentId) || projects[0];
  const searchable = projects.length >= SEARCH_FROM;
  const q = query.trim().toLowerCase();
  const filtered = q ? projects.filter((p) => `${p.name} ${p.domain}`.toLowerCase().includes(q)) : projects;

  const dismiss = useCallback(() => setOpen(false), []);
  useDismiss(open, dismiss, rootRef, buttonRef);

  function openMenu() {
    setQuery("");
    setActive(Math.max(0, projects.findIndex((p) => p.id === currentId)));
    setOpen(true);
  }
  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }
  function choose(p: ShellProject) {
    close();
    if (p.id === currentId) return;
    setSwitchingTo(p);
    if (pathId) start(() => router.push(pathname.replace(`/projects/${pathId}`, `/projects/${p.id}`)));
    else
      start(async () => {
        await selectOnThisPage(p.id, (href) => router.replace(href));
        onSwitched(p.id);
      });
  }

  useEffect(() => {
    if (open) (searchable ? inputRef.current : listRef.current)?.focus();
  }, [open, searchable]);

  // Asked for on opening, so no page load waits on it. Without it the rows just have no number.
  useEffect(() => {
    if (!open) return;
    const ask = new AbortController();
    fetch("/api/projects/status", { signal: ask.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { health: Record<string, number> } | null) => {
        if (d) setHealth(d.health);
      })
      .catch(() => {});
    return () => ask.abort();
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // optionId only depends on the stable useId value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, active]);

  function onListKey(e: KeyboardEvent) {
    const last = filtered.length - 1;
    if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, last));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Home" && !searchable) setActive(0);
    else if (e.key === "End" && !searchable) setActive(last);
    else if (e.key === "Enter" && filtered[active]) choose(filtered[active]);
    else if (e.key === "Escape") close();
    else return;
    e.preventDefault();
  }

  const activeId = filtered[active] ? optionId(active) : undefined;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={buttonRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`Current project: ${shown?.name ?? "none"}. Switch project`}
        aria-busy={pending || undefined}
        title={shown?.name}
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(e) => {
          if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
            e.preventDefault();
            openMenu();
          }
        }}
        className={cn(
          "flex h-9 w-full items-center gap-1.5 rounded-md border border-control-edge bg-tile px-2 text-left transition-colors duration-[120ms] ease-instrument hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent rail:justify-center rail:border-transparent rail:bg-transparent rail:px-0",
          open && "bg-surface-2",
        )}
      >
        <span aria-hidden className="hidden size-7 shrink-0 items-center justify-center rounded-md bg-surface-2 text-xs font-medium text-fg rail:flex">
          {shown?.name.slice(0, 1).toUpperCase()}
        </span>
        <span className={cn("min-w-0 flex-1 truncate text-sm font-medium rail:hidden", pending && "text-muted")}>{shown?.name}</span>
        {shown?.locked && <Badge className="shrink-0 rail:hidden">Read-only</Badge>}
        {pending ? (
          <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin text-muted motion-reduce:animate-none rail:hidden" strokeWidth={1.5} />
        ) : (
          <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted rail:hidden" strokeWidth={1.5} />
        )}
      </button>

      {open && (
        <div
          onBlur={(e) => {
            // Null means focus went nowhere: pressing a row, which can't take focus, blurs the filter
            // box, and closing here would remove the row before its click lands. useDismiss closes the
            // menu for a press outside it.
            if (e.relatedTarget && !rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
          }}
          className="absolute top-full left-0 z-50 mt-1.5 w-full overflow-hidden rounded-lg border border-control-edge bg-surface rail:top-0 rail:left-full rail:mt-0 rail:ml-2 md:w-[28rem]"
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b border-line-soft px-3">
              <Search aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.5} />
              <input
                ref={inputRef}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={activeId}
                aria-autocomplete="list"
                aria-label="Find a project"
                placeholder="Find a project"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onListKey}
                className="h-10 w-full bg-transparent text-sm text-fg outline-none placeholder:text-muted"
              />
            </div>
          )}
          <ul
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Projects"
            tabIndex={-1}
            aria-activedescendant={searchable ? undefined : activeId}
            onKeyDown={searchable ? undefined : onListKey}
            className="max-h-[max(10rem,calc(100dvh-15rem))] scroll-pt-6 overflow-y-auto p-1 outline-none md:max-h-[max(10rem,calc(100dvh-12rem))]"
          >
            {/* Inside the scroller so a scrollbar can't pull it off the numbers, and here from the start so nothing moves when they arrive. Each row says it for a screen reader. */}
            {filtered.length > 0 && (
              <li aria-hidden className="sticky top-0 z-10 flex h-6 items-center justify-end gap-2.5 bg-surface px-2 text-xs text-muted">
                Health
                <span className="size-4 shrink-0" />
              </li>
            )}
            {filtered.map((p, i) => {
              const selected = p.id === currentId;
              const named = p.name !== p.domain;
              const score = health[p.id];
              return (
                <li
                  key={p.id}
                  id={optionId(i)}
                  role="option"
                  aria-selected={selected}
                  title={`${named ? `${p.name} (${p.domain})` : p.name}${score == null ? "" : `. Site health ${score}`}`}
                  onMouseMove={() => setActive(i)}
                  onClick={() => choose(p)}
                  className={cn("flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1 md:py-0.5", i === active && "bg-surface-2")}
                >
                  {/* Name over domain in the narrow drawer; side by side in columns once there's room, so more of the list fits. A project named after its domain has one thing to say, and it takes both columns. */}
                  <span className="min-w-0 flex-1 leading-tight md:grid md:grid-cols-[minmax(0,6fr)_minmax(0,5fr)] md:items-baseline md:gap-3">
                    <span className={cn("block truncate text-sm", selected && "font-medium", !named && "md:col-span-2")}>{p.name}</span>
                    {named && <span className="block truncate text-xs text-muted">{p.domain}</span>}
                  </span>
                  {p.locked && <Badge className="shrink-0">Read-only</Badge>}
                  <span className={cn("data w-6 shrink-0 text-right", score != null && scoreBand(score).tone === "bad" ? "text-bad" : "text-muted")}>
                    {score != null && (
                      <>
                        <span className="sr-only">Site health </span>
                        {score}
                      </>
                    )}
                  </span>
                  <span className="size-4 shrink-0">{selected && <Check aria-hidden className="size-4 text-accent" strokeWidth={1.5} />}</span>
                </li>
              );
            })}
            {!filtered.length && <li className="px-2 py-3 text-sm text-muted">No project matches “{query.trim()}”.</li>}
          </ul>
          <div
            onKeyDown={(e) => {
              if (e.key === "Escape") close();
            }}
            className="flex flex-col gap-0.5 border-t border-line-soft p-1 text-sm md:flex-row md:justify-between"
          >
            {archived > 0 && (
              <MenuLink href="/#archived" icon={Archive} onClick={() => setOpen(false)}>
                Archived projects <span className="text-muted">({archived})</span>
              </MenuLink>
            )}
            <MenuLink href="/projects/new" icon={Plus} onClick={() => setOpen(false)}>
              New project
            </MenuLink>
          </div>
        </div>
      )}
      <span role="status" className="sr-only">
        {pending && switchingTo ? `Switching to ${switchingTo.name}…` : ""}
      </span>
    </div>
  );
}

function MenuLink({ href, icon: Icon, onClick, children }: { href: string; icon: typeof Plus; onClick: () => void; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      prefetch={false}
      onClick={onClick}
      className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-secondary hover:bg-surface-2 hover:text-fg focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
    >
      <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.5} />
      <span>{children}</span>
    </Link>
  );
}
