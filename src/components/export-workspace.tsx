"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { csvLine } from "@/lib/csv";

type Row = Record<string, unknown>;

/** Reads a table page by page from /settings/export, handing each page on. */
async function readTable(table: string, onPage: (rows: Row[]) => void) {
  let after: number | null = 0;
  while (after !== null) {
    const res: Response = await fetch(`/settings/export?table=${encodeURIComponent(table)}&after=${after}`);
    if (!res.ok || !res.headers.get("content-type")?.includes("json")) throw new Error(`${table}: ${res.status}`);
    const page: { rows: Row[]; next: number | null } = await res.json();
    onPage(page.rows);
    after = page.next;
  }
}

function save(filename: string, type: string, parts: BlobPart[]) {
  const url = URL.createObjectURL(new Blob(parts, { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Downloads the whole workspace as one JSON file, or one table as CSV. The browser joins the pages.
 * The person reads each table's `label`. Everything else, the file included, goes by its `name`.
 */
export function ExportWorkspace({ tables }: { tables: { name: string; label: string }[] }) {
  const [table, setTable] = useState(tables[0].name);
  const [reading, setReading] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  async function run(work: () => Promise<void>) {
    setFailed(false);
    try {
      await work();
    } catch (err) {
      console.error(err);
      setFailed(true);
    } finally {
      setReading(null);
    }
  }

  const everything = () =>
    run(async () => {
      const parts: BlobPart[] = [`{"exportedAt":${JSON.stringify(new Date().toISOString())},"tables":{`];
      for (const [i, { name }] of tables.entries()) {
        setReading(name);
        parts.push(`${i ? "," : ""}${JSON.stringify(name)}:[`);
        let first = true;
        await readTable(name, (rows) => {
          for (const row of rows) {
            parts.push(`${first ? "" : ","}${JSON.stringify(row)}`);
            first = false;
          }
        });
        parts.push("]");
      }
      parts.push("}}");
      save(`seopen-export-${today()}.json`, "application/json", parts);
    });

  const oneTable = () =>
    run(async () => {
      setReading(table);
      const parts: BlobPart[] = [];
      let columns: string[] | null = null;
      await readTable(table, (rows) => {
        for (const row of rows) {
          if (!columns) {
            columns = Object.keys(row);
            parts.push(csvLine(columns));
          }
          parts.push(csvLine(columns.map((c) => row[c])));
        }
      });
      save(`seopen-${table}-${today()}.csv`, "text/csv;charset=utf-8", parts);
    });

  const busy = reading !== null;
  return (
    <div className="flex flex-col items-start gap-3">
      <Button type="button" onClick={everything} disabled={busy}>
        Download everything as JSON
      </Button>
      <div className="flex w-full flex-wrap items-end gap-3">
        <Label className="min-w-0 flex-1 basis-64">
          One table
          <Select value={table} onChange={(e) => setTable(e.target.value)} className="w-full">
            {tables.map(({ name, label }) => (
              <option key={name} value={name}>
                {label}
              </option>
            ))}
          </Select>
        </Label>
        <Button type="button" variant="secondary" onClick={oneTable} disabled={busy}>
          Download CSV
        </Button>
      </div>
      <p role="status" className={failed ? "text-xs text-bad" : "text-xs text-muted"}>
        {failed ? "The download stopped before it finished, so nothing was saved. Try again." : busy ? `Reading ${tables.find((t) => t.name === reading)?.label ?? "your data"}…` : "Passwords, keys and our internal billing records aren't included."}
      </p>
    </div>
  );
}
