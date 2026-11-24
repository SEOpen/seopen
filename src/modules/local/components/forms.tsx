"use client";

import { useActionState, useState } from "react";
import { ActionForm } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { HeaderMessage } from "@/components/ui/header-message";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { rules } from "@/plan-policy/rules";
import { addBusiness, addKeywords, checkNow, findListings, removeBusiness, updateBusiness, type ActionState, type FindState } from "../actions";
import { DEFAULT_GRID_SIZE, estimateCheckUsd, GRID_SIZES, priceLabel, RADII_MILES, SEARCH_PRICE_USD } from "../grid";
import { candidateKey } from "../parse";

/**
 * Add a business in two steps: search Google Maps for its name and city, then pick the listing.
 * The pick is matched on cid or place_id from then on, never on the name.
 */
export function FindListingForm({
  projectId,
  showUsd,
  defaultName,
  defaultCity,
  first = false,
}: {
  projectId: number;
  showUsd: boolean;
  /** Prefilled search, e.g. the business the guided setup read from the homepage. */
  defaultName?: string;
  defaultCity?: string;
  /** The page has nothing to show yet, so this lookup is what it's for. */
  first?: boolean;
}) {
  const [found, find, finding] = useActionState<FindState, FormData>(findListings.bind(null, projectId), {});
  const [added, add, adding] = useActionState<FindState, FormData>(addBusiness.bind(null, projectId), {});
  const candidates = found.candidates ?? [];
  return (
    <div className="flex flex-col gap-4">
      <form action={find} className="grid gap-3 @2xl/main:grid-cols-2">
        <Label className="min-w-0">
          Business name
          <Input name="name" required defaultValue={found.name ?? defaultName} autoComplete="organization" />
        </Label>
        <Label className="min-w-0">
          City
          <Input name="city" required defaultValue={found.city ?? defaultCity} autoComplete="address-level2" />
        </Label>
        <div className="@2xl/main:col-span-2">
          <Button type="submit" variant={first ? "primary" : "secondary"} disabled={finding}>
            {finding ? "Searching…" : `Find listing (${priceLabel(SEARCH_PRICE_USD, showUsd)})`}
          </Button>
        </div>
      </form>
      {found.error && (
        <p role="status" className="text-xs text-bad">
          {found.error}
        </p>
      )}
      {candidates.length > 0 && (
        <form action={add} className="flex flex-col gap-3">
          <input type="hidden" name="name" value={found.name} />
          <input type="hidden" name="city" value={found.city} />
          <fieldset>
            <legend className="mb-2 text-xs text-muted">Pick your listing. Ranks are matched on Google&apos;s id for it, not on the name.</legend>
            <ul className="divide-y divide-line rounded-lg border border-line">
              {candidates.map((c, i) => (
                <li key={candidateKey(c)}>
                  <label className="flex cursor-pointer gap-3 px-3 py-2.5 text-sm hover:bg-surface-2 has-[:checked]:bg-surface-2">
                    <input type="radio" name="listing" value={candidateKey(c)} defaultChecked={i === 0} className="mt-1 accent-[var(--accent-fill)]" />
                    <span className="min-w-0">
                      <span className="block font-medium">{c.title}</span>
                      <span className="block text-xs text-muted">
                        {[c.category, c.address, c.rating != null ? `★ ${c.rating.toFixed(1)}${c.votes != null ? ` (${c.votes})` : ""}` : null, c.domain]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="scheduled" defaultChecked className="accent-[var(--accent-fill)]" />
              Check every week
            </label>
            <p className="text-xs text-muted">
              {rules.hasPlans ? `Uses ${rules.researchNoun}` : "Spends on DataForSEO"} without a click: {priceLabel(estimateCheckUsd(DEFAULT_GRID_SIZE, 1), showUsd)} per keyword each week on a{" "}
              {DEFAULT_GRID_SIZE}×{DEFAULT_GRID_SIZE} grid. Leave it off to check only when you press Check now. You can change it later.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={adding}>
              {adding ? "Adding…" : "Track this listing"}
            </Button>
            {added.error && (
              <p role="status" className="text-xs text-bad">
                {added.error}
              </p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}

/** Keywords for a business, one per line or comma separated. */
export function AddKeywordsForm({ projectId, businessId }: { projectId: number; businessId: number }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addKeywords.bind(null, projectId, businessId), {});
  return (
    <form action={action} className="flex flex-col gap-2">
      <Textarea name="keywords" rows={3} aria-label="Keywords to add" />
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Add keywords
        </Button>
        {state.error && (
          <p role="alert" className="text-xs text-bad">
            {state.error}
          </p>
        )}
        {state.ok && <p className="text-xs text-secondary">{state.ok}</p>}
      </div>
    </form>
  );
}

/** Grid size, radius and schedule, with the price of one check updating as you choose. */
export function GridSettingsForm({
  projectId,
  businessId,
  gridSize,
  radiusMiles,
  scheduled,
  keywords,
  showUsd,
}: {
  projectId: number;
  businessId: number;
  gridSize: number;
  radiusMiles: number;
  scheduled: boolean;
  keywords: number;
  showUsd: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(updateBusiness.bind(null, projectId, businessId), {});
  const [size, setSize] = useState(gridSize);
  const points = size * size;
  return (
    <form action={action} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Label>
          Grid
          <Select name="gridSize" value={size} onChange={(e) => setSize(Number(e.target.value))}>
            {GRID_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}×{n} ({n * n} points)
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Radius
          <Select name="radiusMiles" defaultValue={radiusMiles}>
            {RADII_MILES.map((r) => (
              <option key={r} value={r}>
                {r} {r === 1 ? "mile" : "miles"}
              </option>
            ))}
          </Select>
        </Label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="scheduled" defaultChecked={scheduled} className="accent-[var(--accent-fill)]" />
        Check every week
      </label>
      <p className="text-xs text-muted">
        Each check searches every keyword at every point on a phone: {points} points × {keywords} {keywords === 1 ? "keyword" : "keywords"} ={" "}
        {points * keywords} searches, {priceLabel(estimateCheckUsd(size, keywords), showUsd)}.
      </p>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          Save
        </Button>
        {state.error && (
          <p role="alert" className="text-xs text-bad">
            {state.error}
          </p>
        )}
        {state.ok && <p className="text-xs text-secondary">{state.ok}</p>}
      </div>
    </form>
  );
}

/**
 * "Check now" with its price. With no results yet it's what the page is for and runs on one click; after
 * that it asks first. The server refuses a second check while one runs.
 */
export function CheckNowForm({
  projectId,
  businessId,
  gridSize,
  keywords,
  busy,
  hasResults,
  showUsd,
  refused,
}: {
  projectId: number;
  businessId: number;
  gridSize: number;
  keywords: number;
  busy: boolean;
  hasResults: boolean;
  showUsd: boolean;
  /** Why the workspace can't spend. The banner says it, so here the button is just off. */
  refused?: string | null;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(checkNow.bind(null, projectId, businessId), {});
  const points = gridSize * gridSize;
  if (!keywords) return null;
  const price = priceLabel(estimateCheckUsd(gridSize, keywords), showUsd);
  return (
    <form action={action}>
      <SpendConfirm
        first={!hasResults}
        disabled={busy || !!refused}
        pending={pending}
        confirmLabel="Run check"
        question={`Search ${keywords} ${keywords === 1 ? "keyword" : "keywords"} from ${points} points, ${price}?`}
        title={refused ?? `${points} points × ${keywords} ${keywords === 1 ? "keyword" : "keywords"}`}
      >
        {pending ? "Starting…" : busy ? "Checking…" : `Check now (${price})`}
      </SpendConfirm>
      {state.error && (
        <HeaderMessage>
          <Callout role="alert" tone="warn">
            {state.error}
          </Callout>
        </HeaderMessage>
      )}
    </form>
  );
}

export function RemoveBusinessForm({ projectId, businessId, title }: { projectId: number; businessId: number; title: string }) {
  return (
    <ActionForm action={removeBusiness.bind(null, projectId, businessId)} align="end">
      <ConfirmSubmit variant="danger" question={`Stop tracking ${title} and delete its history?`} confirmLabel="Delete">
        Stop tracking
      </ConfirmSubmit>
    </ActionForm>
  );
}
