"use client";

import { Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { filterPalette, type PaletteGroup } from "./nav-model";

/**
 * Cmd+K: find any page or project and go there. It only navigates, and its list is plain paths, so
 * nothing here can repeat a paid lookup or switch the project on a prefetch. The native dialog traps
 * focus, makes the page inert and closes on Escape.
 */
export function CommandPalette({ open, onClose, groups }: { open: boolean; onClose: () => void; groups: PaletteGroup[] }) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-label="Search pages and projects"
      onClose={onClose}
      onClick={(e) => {
        // A press on the backdrop lands on the dialog itself.
        if (e.target === dialogRef.current) onClose();
      }}
      className="m-0 mx-auto mt-[12vh] w-[min(36rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-control-edge bg-surface p-0 text-fg backdrop:bg-(--scrim)"
    >
      {/* Mounted only while open, so it always starts empty. */}
      {open && <PaletteBody groups={groups} onClose={onClose} />}
    </dialog>
  );
}

function PaletteBody({ groups, onClose }: { groups: PaletteGroup[]; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const id = useId();
  const listId = `${id}-list`;
  const optionId = (i: number) => `${id}-option-${i}`;

  const shown = useMemo(() => filterPalette(groups, query), [groups, query]);
  const flat = useMemo(() => shown.flatMap((g) => g.entries), [shown]);

  function go(href: string) {
    onClose();
    // The docs are on the marketing site, outside the app's router: they open in a new tab.
    if (href === "/docs" || href.startsWith("/docs/")) window.open(href, "_blank", "noopener");
    else router.push(href);
  }

  function onKey(e: KeyboardEvent) {
    const last = flat.length - 1;
    if (e.key === "ArrowDown") setActive((i) => Math.min(i + 1, last));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(i - 1, 0));
    else if (e.key === "Enter" && flat[active]) go(flat[active].href);
    else return;
    e.preventDefault();
  }

  useEffect(() => {
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // optionId only depends on the stable useId value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Where each group starts in the flat list the arrow keys move through.
  const starts = shown.map((_, g) => shown.slice(0, g).reduce((n, x) => n + x.entries.length, 0));
  return (
    <>
      <div className="flex items-center gap-2.5 border-b border-line-soft px-3.5">
        <Search aria-hidden className="size-4 shrink-0 text-muted" strokeWidth={1.5} />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={flat[active] ? optionId(active) : undefined}
          aria-autocomplete="list"
          aria-label="Search pages and projects"
          placeholder="Search pages and projects"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKey}
          className="h-12 w-full bg-transparent text-[15px] text-fg outline-none placeholder:text-muted"
        />
      </div>
      <div id={listId} role="listbox" aria-label="Results" className="max-h-[min(24rem,60vh)] overflow-y-auto p-1.5">
        {shown.map((g, gi) => (
          <div key={g.label} role="group" aria-label={g.label} className="mb-1 last:mb-0">
            <div aria-hidden className="px-2 py-1.5 text-xs text-muted">
              {g.label}
            </div>
            {g.entries.map((e, ei) => {
              const i = starts[gi] + ei;
              return (
                <div
                  key={e.href}
                  id={optionId(i)}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => go(e.href)}
                  className={cn("flex cursor-pointer items-baseline justify-between gap-4 rounded-md px-2 py-1.5 text-sm", i === active && "bg-surface-2")}
                >
                  <span className="min-w-0 truncate">{e.label}</span>
                  {e.hint && <span className="shrink-0 text-xs text-muted">{e.hint}</span>}
                </div>
              );
            })}
          </div>
        ))}
        {!flat.length && <p className="px-2 py-6 text-center text-sm text-muted">Nothing matches “{query.trim()}”.</p>}
      </div>
    </>
  );
}
