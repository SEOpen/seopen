import { ISSUES, SEVERITIES, type Severity } from "./taxonomy";

export interface DiffIssue {
  code: string;
  url: string;
}

export interface CodeDiff {
  code: string;
  severity: Severity;
  before: number;
  after: number;
  /** URLs with this issue in the later crawl but not the earlier one. */
  added: string[];
  /** URLs with this issue in the earlier crawl but not the later one. */
  fixed: string[];
}

export interface CrawlDiff {
  codes: CodeDiff[];
  totals: { before: number; after: number; added: number; fixed: number };
}

/**
 * Compares two crawls' issue rows. Issues are matched by (code, URL), so an issue counts as
 * fixed when the URL no longer has it, including when the URL was not crawled the second time.
 * Codes are sorted by severity, then by how much they changed.
 */
export function diffCrawls(before: readonly DiffIssue[], after: readonly DiffIssue[]): CrawlDiff {
  const group = (rows: readonly DiffIssue[]) => {
    const m = new Map<string, Set<string>>();
    for (const r of rows) {
      let s = m.get(r.code);
      if (!s) m.set(r.code, (s = new Set()));
      s.add(r.url);
    }
    return m;
  };
  const a = group(before);
  const b = group(after);
  const codes: CodeDiff[] = [];

  for (const code of new Set([...a.keys(), ...b.keys()])) {
    const sa = a.get(code) ?? new Set<string>();
    const sb = b.get(code) ?? new Set<string>();
    codes.push({
      code,
      severity: ISSUES[code]?.severity ?? "notice",
      before: sa.size,
      after: sb.size,
      added: [...sb].filter((u) => !sa.has(u)).sort(),
      fixed: [...sa].filter((u) => !sb.has(u)).sort(),
    });
  }

  const rank = (s: Severity) => SEVERITIES.indexOf(s);
  codes.sort(
    (x, y) =>
      rank(x.severity) - rank(y.severity) ||
      y.added.length + y.fixed.length - (x.added.length + x.fixed.length) ||
      y.after - x.after ||
      x.code.localeCompare(y.code),
  );

  return {
    codes,
    totals: {
      before: codes.reduce((n, c) => n + c.before, 0),
      after: codes.reduce((n, c) => n + c.after, 0),
      added: codes.reduce((n, c) => n + c.added.length, 0),
      fixed: codes.reduce((n, c) => n + c.fixed.length, 0),
    },
  };
}
