"use client";

import { useActionState, useId, useState } from "react";
import { UpgradeNow } from "@/components/plan-upgrade";
import { Input, Label } from "@/components/ui/input";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { formatNumber, formatUsd } from "@/lib/format";
import { startCrawl, type ActionState } from "../actions";
import { crawlTimeLine } from "../brief";
import { estimateCrawlCost, PRICE_PER_PAGE, priceText } from "../transform";

/**
 * Start-crawl form. `disabledReason` disables every control and says why, e.g. while another
 * crawl is queued or running. With `showCost` (the owner's workspace) it shows a live dollar
 * estimate; customers see their plan's page limit (`planPages`) instead. `first`: there's no
 * finished crawl to show yet, so this is what the page is for and it runs on one click.
 * `refused`: the workspace can't spend. The banner says why, so here the controls are just off.
 */
export function CrawlForm({
  defaultMaxPages,
  defaultJs,
  disabledReason,
  showCost,
  planPages,
  allowJavascript = true,
  first,
  refused = false,
}: {
  defaultMaxPages: number;
  defaultJs: boolean;
  disabledReason?: string | null;
  showCost: boolean;
  planPages: number | null;
  /** Whether the plan lets a crawl render JavaScript. */
  allowJavascript?: boolean;
  first: boolean;
  refused?: boolean;
}) {
  const id = useId();
  const blocked = !!disabledReason;
  const disabled = blocked || refused;
  const [maxPages, setMaxPages] = useState(planPages ? Math.min(defaultMaxPages, planPages) : defaultMaxPages);
  const [js, setJs] = useState(allowJavascript && defaultJs);
  const [state, action, pending] = useActionState<ActionState, FormData>(startCrawl, {});
  const cost = estimateCrawlCost({ maxPages: maxPages || 0, enableJavascript: js, loadResources: true });

  return (
    <>
    <form action={action} className="flex flex-col gap-3" aria-describedby={blocked ? `${id}-why` : undefined}>
      {blocked && (
        <p id={`${id}-why`} className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted" role="status">
          {disabledReason}
        </p>
      )}
      <fieldset disabled={disabled || pending} className="flex flex-wrap items-end gap-3 disabled:opacity-60">
        <Label className="w-32" htmlFor={`${id}-max`}>
          Max pages
          <Input
            id={`${id}-max`}
            name="maxPages"
            type="number"
            min={1}
            max={planPages ?? 5000}
            value={maxPages || ""}
            onChange={(e) => setMaxPages(Number(e.target.value))}
          />
        </Label>
        {allowJavascript && (
          <label htmlFor={`${id}-js`} className="flex h-9 items-center gap-2 text-sm">
            <input
              id={`${id}-js`}
              type="checkbox"
              name="enableJavascript"
              checked={js}
              onChange={(e) => setJs(e.target.checked)}
              className="accent-[var(--accent-fill)]"
            />
            Render JavaScript
          </label>
        )}
        <SpendConfirm
          first={first}
          disabled={disabled || !maxPages}
          pending={pending}
          confirmLabel="Start crawl"
          question={`Crawl up to ${formatNumber(maxPages)} pages${showCost ? `, about ${formatUsd(cost)}` : ""}?`}
        >
          {pending ? "Starting…" : showCost ? `Start crawl (≈ ${formatUsd(cost)})` : "Start crawl"}
        </SpendConfirm>
      </fieldset>
      <p className="text-xs text-muted">
        {showCost ? (
          <>
            Up to {formatUsd(cost)} at{" "}
            {js ? `the JavaScript rate (${priceText(PRICE_PER_PAGE.javascript)}/page)` : `${priceText(PRICE_PER_PAGE.resources)}/page with images, CSS and JS checked`}. Pages the site
            doesn&apos;t have are refunded.
          </>
        ) : (
          <>Included in your plan{planPages ? `, up to ${formatNumber(planPages)} pages per crawl` : ""}. Images, CSS and JS are checked.</>
        )}{" "}
        {crawlTimeLine(planPages)}
      </p>
      {state.error && (
        <p role="status" className="text-xs text-bad">
          {state.error}
        </p>
      )}
    </form>
    {/* Outside the form: UpgradeNow is a form of its own, and forms can't nest. */}
    {state.error && state.upgradable && <UpgradeNow size="sm" className="mt-2" />}
    </>
  );
}
