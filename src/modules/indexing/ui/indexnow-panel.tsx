import { ActionForm } from "@/components/ui/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/section";
import { formatDateTime, formatNumber } from "@/lib/format";
import { checkIndexNowKey, setIndexNow } from "../actions";
import type { IndexingView } from "../data";
import { keyFileUrl } from "../state";

/**
 * IndexNow setup and status, for any project, with or without Search Console. The owner hosts the
 * key file, then switches automatic submission on; nothing is sent before they do.
 */
export function IndexNowPanel({ projectId, domain, view, timeZone }: { projectId: number; domain: string; view: IndexingView; timeZone: string }) {
  const s = view.settings;
  const verified = !!s?.indexnowVerifiedAt;
  const enabled = !!s?.indexnowEnabled;
  const host = s?.indexnowHost ?? domain;
  const key = s?.indexnowKey;

  return (
    <Section
      title="IndexNow: Bing and other search engines"
      description="IndexNow tells Bing, Yandex, Seznam and Naver when a page is new or changed, so they crawl it within hours. Google doesn't use it. It's free."
      actions={<Badge tone={enabled && verified ? "good" : verified ? "neutral" : "warn"}>{enabled && verified ? "On" : enabled ? "Waiting for the key file" : "Off"}</Badge>}
    >
      {!key ? (
        <p className="text-sm text-secondary">The key appears after the first check of this project, within a few hours. Press Check now above to make it sooner.</p>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          <ol className="flex list-decimal flex-col gap-3 pl-5">
            <li>
              Make a text file named <code className="data">{key}.txt</code> containing only <code className="data break-all">{key}</code>.
            </li>
            <li>
              Upload it to the root of the site, so it opens at{" "}
              <a href={keyFileUrl(host, key)} target="_blank" rel="noreferrer" className="data break-all text-accent hover:underline">
                {keyFileUrl(host, key)}
              </a>
              . On Next.js, put it in <code className="data">public/</code>; on WordPress, in the folder that holds <code className="data">wp-config.php</code>.
            </li>
            <li>Turn IndexNow on. SEOpen sends the sitemap&apos;s pages once, then new and changed ones every four hours.</li>
          </ol>

          <div className="flex flex-wrap items-start gap-3">
            <ActionForm action={setIndexNow.bind(null, projectId, !enabled)}>
              <Button type="submit" variant={enabled ? "secondary" : "primary"} size="sm">
                {enabled ? "Turn IndexNow off" : "Turn IndexNow on"}
              </Button>
            </ActionForm>
            <ActionForm action={checkIndexNowKey.bind(null, projectId)}>
              <Button type="submit" variant="secondary" size="sm">
                Check the file
              </Button>
            </ActionForm>
          </div>

          <dl className="grid grid-cols-1 gap-x-8 gap-y-3 @2xl/main:grid-cols-3">
            <div>
              <dt className="text-xs text-muted">Key file</dt>
              <dd>{verified ? `Found ${formatDateTime(s!.indexnowVerifiedAt, timeZone)}` : s?.indexnowCheckedAt ? "Not found" : "Not checked yet"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Last sent</dt>
              <dd>{s?.lastSubmitAt ? `${formatNumber(s.lastSubmitCount ?? 0)} pages, ${formatDateTime(s.lastSubmitAt, timeZone)}` : "Nothing yet"}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Waiting to go</dt>
              <dd>{verified ? `${formatNumber(view.pendingIndexNow)} new or changed` : "–"}</dd>
            </div>
          </dl>
          {s?.indexnowError && <p className="text-bad [overflow-wrap:anywhere]">{s.indexnowError}</p>}
        </div>
      )}
    </Section>
  );
}
