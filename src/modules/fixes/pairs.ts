/**
 * Pages with similar content come in pairs: the audit flags both pages, each naming the other as its
 * closest match. Merging them, or making one say something different, settles both, so a pair is one
 * fix, not two. Pure, so `sync.ts` and its tests share it.
 */

const SIMILAR = "duplicate-content";

/** The audit's detail for a similar-content finding: "https://x/b/ (8 of 10, +2 more)". */
export function similarMatch(detail: string | null): { url: string; similarity: string; more: number } | null {
  const m = detail && /^(\S+) \((\d+(?:\.\d+)?) of 10(?:, \+(\d+) more)?\)$/.exec(detail);
  return m ? { url: m[1], similarity: m[2], more: m[3] ? Number(m[3]) : 0 } : null;
}

/** The page a folded record's pair is tracked under, or null for a record that stands on its own. */
export function coveredBy(fix: { evidence: Record<string, unknown> | null }): string | null {
  const url = fix.evidence?.covered_by;
  return typeof url === "string" ? url : null;
}

interface Finding {
  code: string;
  url: string;
  detail?: string | null;
  pageImpressions: number;
}

/** A similar-content record already on the list. */
export interface PairRecord {
  id: number;
  url: string;
  status: string;
}

/** How settled a page's record is: someone acted on it, it's on the list, or there's none to keep. */
const weight = (r: PairRecord | undefined) => (!r || r.status === "resolved" ? 0 : r.status === "open" ? 1 : 2);

/**
 * Keeps one finding per pair of pages that are each other's closest match. The page that carries the
 * pair is the one whose record someone acted on, else the one already on the list (the older, if both
 * are), else the one people see more of. Two records someone acted on separately both stay.
 * `covered` maps each page left out to the page that carries its pair.
 */
export function foldPairs<F extends Finding>(found: readonly F[], records: readonly PairRecord[]): { keep: F[]; covered: Map<string, string> } {
  const similar = new Map(found.filter((f) => f.code === SIMILAR).map((f) => [f.url, f]));
  const record = new Map(records.map((r) => [r.url, r]));
  const covered = new Map<string, string>();
  for (const f of similar.values()) {
    const other = similar.get(similarMatch(f.detail ?? null)?.url ?? "");
    if (!other || other.url === f.url || f.url > other.url || similarMatch(other.detail ?? null)?.url !== f.url) continue;
    const [a, b] = [record.get(f.url), record.get(other.url)];
    if (weight(a) === 2 && weight(b) === 2) continue;
    // Above zero, `f` carries the pair. With nothing else to go on it does, as the address that sorts first.
    const fFirst = weight(a) - weight(b) || (a && b && weight(a) === 1 ? b.id - a.id : 0) || f.pageImpressions - other.pageImpressions || 1;
    const [carrier, left] = fFirst > 0 ? [f, other] : [other, f];
    covered.set(left.url, carrier.url);
  }
  return { keep: found.filter((f) => f.code !== SIMILAR || !covered.has(f.url)), covered };
}
