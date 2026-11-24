"use client";

import { ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useId, useRef, useTransition, type ComponentProps, type ReactNode } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Long enough to finish a word before the page asks again. */
const TYPING_MS = 350;

/** The query a filter form asks for: what's filled in, and never `run`, which spends on GET. */
export function filterQuery(entries: Iterable<[string, FormDataEntryValue]>): string {
  const query = new URLSearchParams();
  for (const [name, value] of entries) if (typeof value === "string" && value && name !== "run") query.append(name, value);
  return query.toString();
}

/**
 * A row of controls above a table. Picking a value applies it at once, replacing the URL with the same
 * params the page already reads, so a filtered view stays a plain link. Without JavaScript it's a GET
 * form with a button. For free views only: a form that spends has a button and a cost instead.
 *
 * `fold` is for a row too long for a phone: below the main column's @2xl width the fields sit behind one
 * "Filters" button, open when any are active, where `active` counts them. It's a checkbox and CSS, so it
 * works without JavaScript, and an unnamed checkbox never reaches the query.
 */
export function FilterBar({ className, children, action, fold, ...props }: Omit<ComponentProps<"form">, "action"> & { action?: string; children: ReactNode; fold?: { active: number } }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const foldId = useId();
  const foldRef = useRef<HTMLInputElement>(null);
  const anyActive = !!fold && fold.active > 0;

  function apply() {
    clearTimeout(typing.current);
    const form = formRef.current;
    if (!form?.checkValidity()) return;
    const query = filterQuery(new FormData(form).entries());
    start(() => router.replace(`${action ?? pathname}${query ? `?${query}` : ""}`, { scroll: false }));
  }

  // A Clear or range link changes the URL without touching these controls, which keep what was picked.
  useEffect(() => {
    for (const el of Array.from(formRef.current?.elements ?? [])) {
      if (el instanceof HTMLSelectElement || (el instanceof HTMLInputElement && el.name && el.type !== "hidden" && el !== document.activeElement)) {
        const before = el.value;
        el.value = params.get(el.name) ?? "";
        // A control with no empty choice stands on the value the page chose for it.
        if (el instanceof HTMLSelectElement && el.selectedIndex < 0) el.value = before;
      }
    }
  }, [params]);

  useEffect(() => () => clearTimeout(typing.current), []);

  // A link can turn a filter on while the fields are folded, such as a tag in the table. Closing them again is left to the reader.
  useEffect(() => {
    if (anyActive && foldRef.current) foldRef.current.checked = true;
  }, [anyActive]);

  const controls = (
    <>
      {children}
      <noscript>
        <Button type="submit" size="sm" variant="secondary" className="h-8">
          Apply
        </Button>
      </noscript>
    </>
  );

  return (
    <form
      ref={formRef}
      method="get"
      action={action}
      aria-busy={pending || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
      onChange={(e) => {
        // The fold's own checkbox has no name and filters nothing.
        if (e.target instanceof HTMLInputElement && !e.target.name) return;
        clearTimeout(typing.current);
        if (e.target instanceof HTMLInputElement) typing.current = setTimeout(apply, TYPING_MS);
        else apply();
      }}
      className={cn("mb-3 flex flex-wrap items-end gap-x-3 gap-y-2", className)}
      {...props}
    >
      {fold ? (
        <>
          <input ref={foldRef} id={foldId} type="checkbox" defaultChecked={anyActive} className="peer sr-only @2xl/main:hidden" />
          <label
            htmlFor={foldId}
            className={cn(
              buttonVariants({ variant: "secondary", size: "sm" }),
              "cursor-pointer select-none peer-focus-visible:outline-1 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent peer-checked:[&>svg]:rotate-180 @2xl/main:hidden",
            )}
          >
            Filters
            {fold.active > 0 && (
              <span className="data text-fg">
                {fold.active}
                <span className="sr-only"> active</span>
              </span>
            )}
            <ChevronDown aria-hidden className="size-3.5 text-muted" />
          </label>
          {/* `contents` at full width, so the fields sit in the form's own row exactly as they do unfolded. */}
          <div className="contents @max-2xl/main:hidden @max-2xl/main:w-full @max-2xl/main:flex-wrap @max-2xl/main:items-end @max-2xl/main:gap-x-3 @max-2xl/main:gap-y-2 @max-2xl/main:peer-checked:flex">{controls}</div>
        </>
      ) : (
        controls
      )}
      <span role="status" className={cn("self-center text-xs text-muted", !pending && "sr-only")}>
        {pending ? "Updating…" : ""}
      </span>
    </form>
  );
}
