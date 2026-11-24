import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDateTimeZoned, formatNumber } from "@/lib/format";
import { USER_AGENT_ONLY, type AccessReport } from "../access";
import { qs } from "./bits";

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname || "/";
  } catch {
    return url;
  }
};

function robotsLine(r: AccessReport["robots"], timeZone: string): string {
  const when = `fetched ${formatDateTimeZoned(r.fetchedAt, timeZone)}`;
  if (r.status === null) return `robots.txt couldn't be fetched (${when}): ${r.error ?? "no answer"}. Its rules weren't checked.`;
  if (r.status >= 500) return `robots.txt answered ${r.status} (${when}). Crawlers read a server error there as "keep out".`;
  if (!r.found) return `No robots.txt: it answered ${r.status} (${when}), so every crawler is allowed.`;
  return `Live robots.txt, ${when}.`;
}

/** The "Crawler and AI access" panel on the audit overview: what robots.txt and the server let each crawler do. */
export function AccessPanel({ report, timeZone }: { report: AccessReport; timeZone: string }) {
  const search = report.crawlers.filter((c) => c.role === "search");
  const training = report.crawlers.filter((c) => c.role === "training");
  const tokens = report.probes[0]?.bots.map((b) => b.token) ?? [];
  return (
    <div className="flex flex-col gap-5 text-sm">
      <p className="text-secondary">
        {robotsLine(report.robots, timeZone)}{" "}
        <Link href={`/audit/issues${qs({ category: "access" })}`} className="text-accent hover:underline">
          Access issues
        </Link>
      </p>

      {search.length > 0 && (
        <div className="grid gap-5 @3xl/main:grid-cols-2">
          <CrawlerList title="Search crawlers" note="These decide whether a search engine or AI assistant can show and cite your pages. A block here is an error." rows={search} blockedTone="bad" />
          <CrawlerList title="Training crawlers" note="Your choice: blocking these keeps your content out of AI training sets and doesn't affect search or citations. They're never counted as issues." rows={training} blockedTone="neutral" />
        </div>
      )}

      {report.probes.length > 0 && (
        <div>
          <h3 className="mb-1 text-[13px] font-medium">Bot fetch test</h3>
          <p className="mb-2 text-xs text-muted">{USER_AGENT_ONLY}</p>
          <div className="panel overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="table-head">
                <tr>
                  <th className="h-9 px-3 text-left font-medium">Page</th>
                  <th className="h-9 px-3 text-right font-medium">Visitor</th>
                  {tokens.map((t) => (
                    <th key={t} className="h-9 px-3 text-right font-medium">
                      {t}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.probes.map((p) => (
                  <tr key={p.url} className="border-t border-line-soft">
                    <td className="max-w-64 truncate px-3 py-2.5" title={p.url}>
                      {pathOf(p.url)}
                    </td>
                    <td className="data px-3 py-2.5 text-right">{p.baseline ?? "–"}</td>
                    {p.bots.map((b) => (
                      <td key={b.token} className={`data px-3 py-2.5 text-right ${p.baseline === 200 && b.status !== 200 ? "text-warn" : ""}`} title={b.error}>
                        {b.status ?? "–"}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <ul className="flex flex-col gap-1 text-secondary">
        <li>
          {report.rendered
            ? `Raw vs rendered: compared the raw HTML of ${formatNumber(report.rendered.checked)} ${report.rendered.checked === 1 ? "page" : "pages"} with the rendered crawl, and ${formatNumber(report.rendered.flagged)} need JavaScript for their H1 or most of their text.`
            : "Raw vs rendered: runs on crawls with JavaScript rendering on, which this one didn't use."}
        </li>
        {report.http && <li>{report.http.finalUrl?.startsWith("https://") ? "http:// redirects to https://." : `http:// answered ${report.http.status ?? "nothing"} without moving to https://.`}</li>}
        {report.sitemap && (
          <li>
            {report.sitemap.status === 200
              ? `Sitemap ${pathOf(report.sitemap.url)} lists ${formatNumber(report.sitemap.listed)} ${report.sitemap.listed === 1 ? "URL" : "URLs"}, checked against this crawl.`
              : `Sitemap ${pathOf(report.sitemap.url)} answered ${report.sitemap.status ?? "nothing"}, so its URLs weren't checked.`}
          </li>
        )}
      </ul>
    </div>
  );
}

function CrawlerList({ title, note, rows, blockedTone }: { title: string; note: string; rows: AccessReport["crawlers"]; blockedTone: "bad" | "neutral" }) {
  return (
    <div>
      <h3 className="mb-1 text-[13px] font-medium">{title}</h3>
      <p className="mb-2 text-xs text-muted">{note}</p>
      <ul className="panel divide-y divide-line-soft">
        {rows.map((c) => (
          <li key={c.token} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="min-w-0">
              <div className="font-medium">{c.token}</div>
              <div className="text-xs text-muted">
                {c.does}
                {c.rule ? ` · ${c.rule}` : ""}
              </div>
            </div>
            <Badge tone={c.allowed ? "good" : blockedTone}>{c.allowed ? "Allowed" : "Blocked"}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}
