"use client";

import { useEffect, useId, useRef, useState } from "react";
import { findCities } from "@/app/actions/places";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Place } from "@/lib/dataforseo/place-names";
import { cn } from "@/lib/utils";

/**
 * Picks a city of `country` from DataForSEO's list, by typing. The hidden input carries its code
 * (`emptyValue` when none), so the picker works in any form.
 */
export function CityPicker({
  country,
  value,
  onChange,
  name,
  emptyValue = "",
  label,
  placeholder = "Search for a city",
  className,
}: {
  country: number;
  value: Place | null;
  onChange: (city: Place | null) => void;
  name: string;
  emptyValue?: string;
  /** Accessible name of the search box. */
  label: string;
  placeholder?: string;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; cities: Place[]; error?: string } | null>(null);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const typed = query.trim();
  const searching = typed.length >= 2 && found?.query !== `${country}:${typed}`;
  const cities = found && !searching ? found.cities : [];

  useEffect(() => {
    if (typed.length < 2) return;
    const key = `${country}:${typed}`;
    let stale = false;
    const timer = setTimeout(async () => {
      // A dropped connection rejects the call. Without an answer the list would say "Searching" for good.
      const res = await findCities(country, typed).catch(() => ({ cities: [], error: "Couldn't load the list of cities. Try again in a moment." }));
      if (!stale) {
        setFound({ query: key, ...res });
        setActive(0);
      }
    }, 250);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [country, typed]);

  function pick(city: Place | null) {
    onChange(city);
    setQuery("");
    setOpen(false);
  }

  if (value) {
    return (
      <div className={cn("flex min-h-9 items-center justify-between gap-2 rounded-md border border-line bg-surface px-3 py-1 text-sm font-normal", className)}>
        <input type="hidden" name={name} value={value.code} />
        <span className="min-w-0 truncate">{value.name}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={`Remove ${value.name}`}
          onClick={() => {
            pick(null);
            // The box replaces this button, so keep the keyboard where it was working.
            setTimeout(() => inputRef.current?.focus());
          }}
        >
          Remove
        </Button>
      </div>
    );
  }

  const showList = open && typed.length >= 2;
  return (
    <div className={cn("relative", className)}>
      <input type="hidden" name={name} value={emptyValue} />
      <Input
        ref={inputRef}
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && cities[active] ? `${listId}-${cities[active].code}` : undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          else if (e.key === "ArrowDown" && cities.length) {
            e.preventDefault();
            setOpen(true);
            setActive((a) => (a + 1) % cities.length);
          } else if (e.key === "ArrowUp" && cities.length) {
            e.preventDefault();
            setActive((a) => (a - 1 + cities.length) % cities.length);
          } else if (e.key === "Enter" && typed) {
            // Enter chooses here; it should never send a form with a half-typed city in it.
            e.preventDefault();
            if (showList && cities[active]) pick(cities[active]);
          }
        }}
      />
      {showList && (
        <div id={listId} role="listbox" aria-label={label} className="absolute z-20 mt-1 max-h-64 w-full min-w-64 overflow-y-auto rounded-lg border border-control-edge bg-surface py-1 text-sm font-normal">
          {cities.map((c, i) => (
            <div
              key={c.code}
              id={`${listId}-${c.code}`}
              role="option"
              aria-selected={i === active}
              // Before the box's blur closes the list.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
              onMouseEnter={() => setActive(i)}
              className={cn("cursor-pointer px-3 py-1.5", i === active && "bg-surface-2")}
            >
              {c.name}
            </div>
          ))}
          {searching && <p className="px-3 py-1.5 text-muted">Searching…</p>}
          {!searching && found?.error && (
            <p role="alert" className="px-3 py-1.5 text-bad">
              {found.error}
            </p>
          )}
          {!searching && !found?.error && !cities.length && <p className="px-3 py-1.5 text-muted">No city by that name in this country.</p>}
        </div>
      )}
    </div>
  );
}
