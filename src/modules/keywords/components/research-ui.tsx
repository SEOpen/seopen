import type { ReactNode } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { LOCATIONS, locationName } from "@/lib/dataforseo/locations";
import type { Place } from "@/lib/dataforseo/place-names";
import { formatShortDate } from "@/lib/format";
import { currentTimeZone } from "@/lib/workspace/current";
import { costLabel, maxCostLabel } from "../format";
import type { LookupQuote } from "../lookup-quote";
import { LookupButton } from "./lookup-button";
import { MarketFields } from "./market-fields";

/**
 * GET form for research tools. Submitting adds `run=1`, so the query runs straight away;
 * the button says what that costs, and doesn't ask twice: the person just typed the lookup.
 * `quiet` makes the button secondary, for when the page already leads on something else.
 * `refused`: why the workspace can't spend (`spendState`), which turns the button off.
 */
const priceLabel = (usd: number, ceiling: boolean) => (ceiling ? maxCostLabel(usd) : costLabel(usd));

export function ResearchForm({
  action,
  q,
  placeholder,
  locationCode,
  costUsd,
  freshUsd,
  ceiling = false,
  quote = { kind: "flat", label: priceLabel(freshUsd, ceiling) },
  hidden,
  label = "Analyze",
  withCity = false,
  city = null,
  quiet = false,
  refused,
}: {
  action: string;
  q: string;
  placeholder: string;
  locationCode: number;
  /** What submitting costs as the form stands: 0 when what's on the page is saved. */
  costUsd: number;
  /** What a new search costs, shown as soon as the person changes the form. */
  freshUsd: number;
  /** The prices are ceilings, because the lookup is billed per row returned. */
  ceiling?: boolean;
  /** For a new search whose price depends on what's typed. Replaces `freshUsd` on the button. */
  quote?: LookupQuote;
  hidden?: Record<string, string>;
  label?: string;
  /** Offers a city next to the country. Only for pages whose data goes below country level. */
  withCity?: boolean;
  city?: Place | null;
  quiet?: boolean;
  refused?: string | null;
}) {
  return (
    // Keyed on what it loaded: a link to another lookup keeps this page mounted, and the fields and price must start over.
    <form key={`${q}|${locationCode}|${city?.code ?? 0}`} action={action} className="flex flex-wrap items-center gap-2">
      <Input name="q" defaultValue={q} placeholder={placeholder} required className="w-72 max-w-full" aria-label={placeholder} />
      {withCity ? (
        <MarketFields locationCode={locationCode} city={city} />
      ) : (
        <Select name="loc" defaultValue={String(locationCode)} aria-label="Market">
          {LOCATIONS.map((l) => (
            <option key={l.code} value={l.code}>
              {l.name}
            </option>
          ))}
        </Select>
      )}
      {Object.entries(hidden ?? {}).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="run" value="1" />
      <LookupButton label={priceLabel(costUsd, ceiling)} quote={quote} quiet={quiet} refused={refused}>
        {label}
      </LookupButton>
    </form>
  );
}

/** Says that a research page stays on the country although the project tracks a city. */
export function CountryDataNote({ project, locationCode, what }: { project: { locationCode: number; cityName: string | null } | null; locationCode: number; what: string }) {
  if (!project?.cityName || project.locationCode !== locationCode) return null;
  return (
    <p className="mb-4 text-xs text-muted">
      {what} {locationName(locationCode)}, not {project.cityName}: this data isn&apos;t available by city.
    </p>
  );
}

/** Shown in place of results that aren't cached yet. Nothing is spent until the button is clicked. */
export function RunPrompt({
  title,
  description,
  href,
  costUsd,
  ceiling = false,
  refused,
}: {
  title: string;
  description?: ReactNode;
  href: string;
  costUsd: number;
  ceiling?: boolean;
  refused?: string | null;
}) {
  return (
    <div className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-4">
      <div className="min-w-0 flex-[1_1_16rem]">
        <div className="text-[15px] font-medium">{title}</div>
        {description && <p className="mt-0.5 text-sm text-secondary">{description}</p>}
      </div>
      {/* While the workspace can't spend, the banner says why: the button is off, carries the reason, and has no address to follow. */}
      {refused ? (
        <Button type="button" disabled title={refused}>
          Run ({priceLabel(costUsd, ceiling)})
        </Button>
      ) : (
        // A paid call: never prefetch it.
        <ButtonLink href={href} prefetch={false}>
          Run ({priceLabel(costUsd, ceiling)})
        </ButtonLink>
      )}
    </div>
  );
}

/**
 * For a page that already shows part of what it asked for: the rest isn't loaded, and loading it spends.
 * So it's secondary and asks in place. A GET form, so no link anywhere carries `run` and nothing can prefetch it.
 */
export function RunRest({
  action,
  params,
  description,
  costUsd,
  ceiling = false,
  refused,
}: {
  action: string;
  params: Record<string, string | number | undefined>;
  description: ReactNode;
  costUsd: number;
  ceiling?: boolean;
  refused?: string | null;
}) {
  return (
    <form action={action} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <p className="min-w-0 flex-[1_1_16rem] text-sm text-secondary">{description}</p>
      {Object.entries(params).map(([k, v]) => (v === undefined || v === "" ? null : <input key={k} type="hidden" name={k} value={v} />))}
      <input type="hidden" name="run" value="1" />
      <SpendConfirm question={`Spend ${priceLabel(costUsd, ceiling)} to load the rest?`} disabled={!!refused} title={refused ?? undefined}>
        Load the rest ({priceLabel(costUsd, ceiling)})
      </SpendConfirm>
    </form>
  );
}

/** Placeholder inside a section whose data isn't loaded. */
export function NotLoaded({ costUsd, ceiling = false }: { costUsd: number; ceiling?: boolean }) {
  return <p className="px-4 py-6 text-center text-sm text-muted">Not loaded yet ({priceLabel(costUsd, ceiling)}).</p>;
}

export async function FetchedNote({ fetchedAt, cached }: { fetchedAt: Date | null; cached: boolean }) {
  if (!fetchedAt) return null;
  const timeZone = await currentTimeZone();
  return (
    <span className="text-xs text-muted">
      {cached ? "Data from" : "Fetched"} {formatShortDate(fetchedAt, timeZone)}
    </span>
  );
}
