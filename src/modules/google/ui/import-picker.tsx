"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/input";
import { importFromSearchConsole, type ImportState } from "../actions";
import { siteLabel } from "../matching";

export interface ImportCandidate {
  domain: string;
  siteUrl: string;
  /** GA4 property suggested by domain, preselected in the row. */
  ga4Suggestion: string | null;
}

export interface Ga4Option {
  property: string;
  label: string;
}

/**
 * Search Console sites that aren't SEOpen projects yet. Tick the ones to import and pick a GA4
 * property for each; nothing is created until "Import selected".
 */
export function ImportPicker({ candidates, ga4Options }: { candidates: ImportCandidate[]; ga4Options: Ga4Option[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, action, pending] = useActionState<ImportState, FormData>(importFromSearchConsole, null);
  // After an import the page refreshes without those sites, so only count ticks that still have a row.
  const count = candidates.filter((c) => selected.has(c.siteUrl)).length;
  const all = count === candidates.length;

  const toggle = (siteUrl: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(siteUrl);
      else next.delete(siteUrl);
      return next;
    });

  return (
    <form action={action}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-2">
        <Button type="button" variant="secondary" size="sm" onClick={() => setSelected(all ? new Set() : new Set(candidates.map((c) => c.siteUrl)))}>
          {all ? "Select none" : "Select all"}
        </Button>
        <span className="text-xs text-muted">
          {count} of {candidates.length} selected
        </span>
        {state && (
          <span role={state.ok ? undefined : "alert"} className={state.ok ? "text-xs text-secondary" : "text-xs text-bad"}>
            {state.message}
          </span>
        )}
        <Button type="submit" size="sm" className="ml-auto" disabled={!count || pending}>
          {pending ? "Importing…" : count ? `Import ${count} selected` : "Import selected"}
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="table-head">
          <tr>
            <th scope="col" className="h-9 w-10 px-4">
              <span className="sr-only">Import</span>
            </th>
            <th scope="col" className="h-9 px-4 text-left font-medium">New project</th>
            <th scope="col" className="h-9 px-4 text-left font-medium">Search Console</th>
            <th scope="col" className="h-9 px-4 text-left font-medium">GA4</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c) => {
            const id = `import-${c.siteUrl}`;
            return (
              <tr key={c.siteUrl} className="border-t border-line-soft align-middle">
                <td className="px-4 py-2">
                  <input
                    id={id}
                    type="checkbox"
                    name="site"
                    value={c.siteUrl}
                    checked={selected.has(c.siteUrl)}
                    onChange={(e) => toggle(c.siteUrl, e.target.checked)}
                    className="size-4 accent-[var(--accent-fill)]"
                  />
                </td>
                <td className="px-4 py-2">
                  <label htmlFor={id} className="cursor-pointer font-medium">
                    {c.domain}
                  </label>
                </td>
                <td className="px-4 py-2 text-xs text-muted">{siteLabel(c.siteUrl)}</td>
                <td className="px-4 py-2">
                  <Select
                    name={`ga4:${c.siteUrl}`}
                    defaultValue={c.ga4Suggestion ?? ""}
                    aria-label={`GA4 property for ${c.domain}`}
                    className="h-8 w-full max-w-72 text-xs"
                  >
                    <option value="">None</option>
                    {ga4Options.map((g) => (
                      <option key={g.property} value={g.property}>
                        {g.label}
                      </option>
                    ))}
                  </Select>
                  {c.ga4Suggestion && <div className="mt-1 text-xs text-secondary">Suggested by domain</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </form>
  );
}
