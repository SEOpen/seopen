"use client";

import { use, useState } from "react";
import { Label, Select } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import type { OtherSourceChoices, SourceChoice } from "@/modules/analytics-source/choices";
import { SOURCE_FIELD, isAnalyticsSource, sourceMatches, startingSource, type AnalyticsSource } from "@/modules/analytics-source/match";
import { bareDomain, currentPick, siteLabel, suggestGscProperty, type PropertyPick } from "../matching";
import type { GoogleChoices } from "../properties";

/** After an error the form remounts, so what was chosen comes back with what was typed. */
function chosen(value: string | undefined, domain: string | undefined): PropertyPick | null {
  return value === undefined ? null : { domain: bareDomain(domain ?? ""), value };
}

const NO_OTHERS: OtherSourceChoices = { posthog: { state: "hidden" }, plausible: { state: "hidden" }, umami: { state: "hidden" } };
const resolved = Promise.resolve(NO_OTHERS);

/**
 * The Search Console site and Analytics source for the address typed on the new project form. The
 * best match starts selected and shows here, so a link is never made without being seen: a
 * property counts towards the one-trial rule. A project takes its Analytics from one source, so
 * GA4, PostHog, Plausible and Umami share one switch and only the chosen one's list is sent. The action
 * links the fields when the project is created.
 */
export function NewProjectProperties({
  choices,
  others = resolved,
  domain,
  typed,
}: {
  choices: Promise<GoogleChoices>;
  others?: Promise<OtherSourceChoices>;
  domain: string;
  typed?: Record<string, string>;
}) {
  const google = use(choices);
  const { posthog, plausible, umami } = use(others);
  const [gsc, setGsc] = useState(() => chosen(typed?.gscProperty, typed?.domain));
  const [picks, setPicks] = useState<Partial<Record<AnalyticsSource, PropertyPick | null>>>(() => ({
    GA4: chosen(typed?.ga4Property, typed?.domain),
    PostHog: chosen(typed?.posthogProject, typed?.domain),
    Plausible: chosen(typed?.plausibleSite, typed?.domain),
    Umami: chosen(typed?.umamiSite, typed?.domain),
  }));
  const [sourcePick, setSourcePick] = useState<{ domain: string; source: AnalyticsSource } | null>(() =>
    isAnalyticsSource(typed?.analyticsSource) ? { domain: bareDomain(typed?.domain ?? ""), source: typed.analyticsSource } : null,
  );

  const ga4: SourceChoice<{ property: string; label: string }> =
    google.state === "connected"
      ? { state: "connected", items: google.ga4.map((g) => ({ property: g.property, label: `${g.propertyName} · ${g.accountName} (${g.property.replace("properties/", "")})` })) }
      : google.state === "connect"
        ? { state: "connect" }
        : { state: "hidden" };
  const states: Record<AnalyticsSource, SourceChoice<unknown>> = { GA4: ga4, PostHog: posthog, Plausible: plausible, Umami: umami };
  const offered = (Object.keys(states) as AnalyticsSource[]).filter((s) => states[s].state !== "hidden");
  if (!offered.length) return null;

  const address = bareDomain(domain);
  // Google not connected and nothing else to offer: the old one-line pointer, and nothing to choose yet.
  if (google.state === "connect" && offered.length === 1) return <ConnectGoogle />;
  if (!address.includes(".")) return google.state === "connect" ? <ConnectGoogle /> : null;

  const sites = google.state === "connected" ? google.sites : [];
  const matches = sourceMatches(address, {
    ga4: google.state === "connected" ? google.ga4 : undefined,
    posthog: posthog.state === "connected" ? posthog.items : undefined,
    plausible: plausible.state === "connected" ? plausible.items : undefined,
    umami: umami.state === "connected" ? umami.items : undefined,
  });
  const connected = offered.filter((s) => states[s].state === "connected");
  const fallback = startingSource(offered, connected, matches) ?? offered[0];
  const source = sourcePick && sourcePick.domain === address && offered.includes(sourcePick.source) ? sourcePick.source : fallback;
  const gscMatch = suggestGscProperty(address, sites);
  const anyMatch = !!gscMatch || offered.some((s) => matches[s]);
  const value = (s: AnalyticsSource) => currentPick(address, picks[s] ?? null, matches[s]?.value ?? null);
  const pick = (s: AnalyticsSource, v: string) => setPicks((p) => ({ ...p, [s]: { domain: address, value: v } }));
  const current = states[source];

  return (
    <div className="grid gap-4">
      <div className="text-[13px] font-medium text-fg">
        {anyMatch ? "Found in your connected accounts" : "Nothing in your connected accounts matches this address"}
        <p className="mt-0.5 text-xs font-normal text-muted">
          {anyMatch ? "These link to the project when you create it, and their data starts syncing. Change them or pick None." : "Pick one if it's listed under another name, or leave these on None."}
        </p>
      </div>
      {google.state === "connect" && <ConnectGoogle />}
      {sites.length > 0 && (
        <Label>
          Search Console
          <Select name="gscProperty" className="w-full" value={currentPick(address, gsc, gscMatch)} onChange={(e) => setGsc({ domain: address, value: e.target.value })}>
            <option value="">None</option>
            {sites.map((s) => (
              <option key={s.siteUrl} value={s.siteUrl}>
                {siteLabel(s.siteUrl)}
              </option>
            ))}
          </Select>
        </Label>
      )}
      <div className="grid gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-medium text-fg">
          <span id="analytics-source-label">Analytics</span>
          {offered.length > 1 && <Segmented label="Analytics source" options={offered} value={source} onChange={(s) => setSourcePick({ domain: address, source: s })} />}
        </div>
        <input type="hidden" name="analyticsSource" value={source} />
        {current.state === "connected" ? (
          (current.items as unknown[]).length ? (
            <Select name={SOURCE_FIELD[source]} aria-labelledby="analytics-source-label" className="w-full" value={value(source)} onChange={(e) => pick(source, e.target.value)}>
              <option value="">None</option>
              {source === "GA4" &&
                ga4.state === "connected" &&
                ga4.items.map((g) => (
                  <option key={g.property} value={g.property}>
                    {g.label}
                  </option>
                ))}
              {source === "PostHog" &&
                posthog.state === "connected" &&
                posthog.items.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              {source === "Plausible" &&
                plausible.state === "connected" &&
                plausible.items.map((s) => (
                  <option key={s.domain} value={s.domain}>
                    {s.domain}
                  </option>
                ))}
              {source === "Umami" &&
                umami.state === "connected" &&
                umami.items.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name && s.name !== s.domain ? `${s.name} · ${s.domain}` : s.domain}
                  </option>
                ))}
            </Select>
          ) : (
            <p className="text-xs text-muted">{EMPTY[source]}</p>
          )
        ) : source === "GA4" ? (
          <p className="text-xs text-muted">Connect Google above to pick a Google Analytics property.</p>
        ) : (
          <p className="text-xs text-muted">
            {source} isn&apos;t connected yet. Connect it on the project&apos;s Analytics page after creating it, then pick its {source === "PostHog" ? "project" : source === "Umami" ? "website" : "site"} there.
          </p>
        )}
      </div>
    </div>
  );
}

const EMPTY: Record<AnalyticsSource, string> = {
  GA4: "Your Google account has no Analytics properties yet.",
  PostHog: "Your PostHog connection has no projects yet.",
  Plausible: "Your Plausible key has no sites yet.",
  Umami: "Your Umami connection has no websites yet.",
};

function ConnectGoogle() {
  return (
    <p className="text-xs text-muted">
      Use Search Console or Google Analytics?{" "}
      <a href="/api/google/connect" className="text-accent hover:underline">
        Connect Google
      </a>{" "}
      first to link them here, or do it after creating the project.
    </p>
  );
}
