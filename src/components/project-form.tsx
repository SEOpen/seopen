"use client";

import { Suspense, useActionState, useEffect, useRef, useState } from "react";
import { suggestCities, type CitySuggestion } from "@/app/actions/places";
import { CityPicker } from "@/components/city-picker";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { LOCATIONS, locationName } from "@/lib/dataforseo/locations";
import type { Place } from "@/lib/dataforseo/place-names";
import type { Project } from "@/lib/projects";
import type { OtherSourceChoices } from "@/modules/analytics-source/choices";
import type { GoogleChoices } from "@/modules/google/properties";
import { NewProjectProperties } from "@/modules/google/ui/new-project-properties";

/** What a project form's action returns: the problem with what was typed, or that it saved. Null before a submit. */
export type ProjectFormState = { error?: string; values?: Record<string, string>; saved?: boolean; movedTo?: string } | null;

const LANGUAGES: Record<string, string> = { en: "English", de: "German", fr: "French", es: "Spanish", pt: "Portuguese", it: "Italian", nl: "Dutch", sv: "Swedish", ja: "Japanese" };
const marketLanguage = (code: number) => LOCATIONS.find((l) => l.code === code)?.languageCode ?? "en";

export function ProjectForm({
  action,
  project,
  submitLabel,
  withCompetitors = false,
  googleChoices,
  analyticsChoices,
  next,
  hint,
}: {
  action: (prev: ProjectFormState, formData: FormData) => Promise<ProjectFormState>;
  project?: Project;
  submitLabel: string;
  withCompetitors?: boolean;
  /** Offers the account's Search Console and Analytics properties for the address typed. Streams in, so the form never waits for Google. */
  googleChoices?: Promise<GoogleChoices>;
  /** PostHog and Plausible beside GA4, behind one Analytics switch. Streams in like `googleChoices`. */
  analyticsChoices?: Promise<OtherSourceChoices>;
  /** A second submit, shown first, that goes on to something once the project exists: `next=setup` opens the guided setup. */
  next?: { label: string; value: string };
  /** One line under the buttons saying what each one does. */
  hint?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const typed = state?.values;
  const [domain, setDomain] = useState(project?.domain ?? "");
  const domainField = useRef<HTMLInputElement>(null);
  // An address typed before the page came to life, or put back by the browser, fired no change.
  useEffect(() => {
    if (domainField.current) setDomain(domainField.current.value);
  }, []);
  const [market, setMarket] = useState(Number(typed?.locationCode ?? project?.locationCode ?? 2840));
  const [language, setLanguage] = useState(typed?.languageCode ?? project?.languageCode ?? marketLanguage(market));
  const [city, setCity] = useState<Place | null>(project?.cityCode && project.cityName ? { code: project.cityCode, name: project.cityName } : null);
  const [suggestion, setSuggestion] = useState<CitySuggestion>(null);
  const projectId = project?.id;
  const noCitySaved = project && !project.cityCode;
  // Only an existing project can have a Local SEO listing to go by.
  useEffect(() => {
    if (!projectId || !noCitySaved) return;
    let stale = false;
    suggestCities(projectId, market).then((s) => {
      if (!stale) setSuggestion(s);
    });
    return () => {
      stale = true;
    };
  }, [projectId, noCitySaved, market]);
  const place = city?.name ?? locationName(market);
  const moving = !!project && (city?.code ?? market) !== (project.cityCode ?? project.locationCode);
  // A fast double click would otherwise send the form twice before `pending` turns on.
  const sent = useRef<ProjectFormState | undefined>(undefined);
  const languages = language in LANGUAGES ? LANGUAGES : { ...LANGUAGES, [language]: language };

  return (
    <form
      // Remount after an error so the fields show what was typed rather than resetting.
      key={typed ? JSON.stringify(typed) : "blank"}
      action={formAction}
      onSubmit={(e) => {
        if (sent.current === state) e.preventDefault();
        else sent.current = state;
      }}
      className="grid max-w-xl gap-4"
    >
      {state?.error && <Callout tone="bad" title={state.error} role="alert" />}
      <Label>
        Website address
        <Input
          ref={domainField}
          name="domain"
          required
          type="text"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          autoFocus={!project}
          defaultValue={typed?.domain ?? project?.domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="e.g. yoursite.com"
        />
      </Label>
      <Label>
        Name <span className="font-normal text-muted">(optional, the website address if left blank)</span>
        <Input name="name" maxLength={80} defaultValue={typed?.name ?? project?.name} placeholder="e.g. your business's name" />
      </Label>
      <div className="grid gap-4 @2xl/main:grid-cols-2">
        <Label>
          Country you want to rank in
          <Select
            name="locationCode"
            value={market}
            onChange={(e) => {
              const code = Number(e.target.value);
              setMarket(code);
              setLanguage(marketLanguage(code));
              // A city belongs to one country.
              setCity(null);
              setSuggestion(null);
            }}
          >
            {LOCATIONS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </Select>
        </Label>
        <Label>
          Language people search in
          <Select name="languageCode" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {Object.entries(languages).map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Label>
      </div>
      <div className="flex flex-col gap-1.5 text-[13px] font-medium text-fg">
        <span>
          City you want to rank in <span className="font-normal text-muted">(optional, the whole country if left empty)</span>
        </span>
        <CityPicker country={market} value={city} onChange={setCity} name="cityCode" label="City you want to rank in" />
        <p className="text-xs font-normal text-muted">
          Rankings and the live top 10 in Keyword research search from this city, so you see what people there see. Domain analysis, AI visibility and keyword
          metrics stay on the country, because that data isn&apos;t available by city.
        </p>
        {suggestion && !city && (
          <div className="flex flex-wrap items-center gap-2 text-xs font-normal text-muted">
            <span>Your Local SEO listing is in {suggestion.listing}.</span>
            {suggestion.cities.map((c) => (
              <Button key={c.code} type="button" variant="secondary" size="sm" onClick={() => setCity(c)}>
                Use {c.name}
              </Button>
            ))}
          </div>
        )}
      </div>
      {moving && (
        <Callout tone="warn" title="This starts a new baseline">
          From the next check, rankings are searched from {place}. Positions can differ a lot from place to place, so your numbers will change and new checks won&apos;t be
          compared with earlier ones. Earlier checks stay readable in Rankings.
        </Callout>
      )}
      {googleChoices && (
        <Suspense fallback={null}>
          <NewProjectProperties choices={googleChoices} others={analyticsChoices} domain={domain} typed={typed} />
        </Suspense>
      )}
      {withCompetitors && (
        <Label>
          Competitors <span className="font-normal text-muted">(optional, one website per line)</span>
          <Textarea name="competitors" rows={4} defaultValue={typed?.competitors} placeholder={"e.g. a-rival.com\nanother-rival.com"} />
        </Label>
      )}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          {next && (
            <Button type="submit" name="next" value={next.value} disabled={pending}>
              {next.label}
            </Button>
          )}
          <Button type="submit" variant={next ? "secondary" : "primary"} disabled={pending}>
            {submitLabel}
          </Button>
          {state?.saved && !pending && (
            <span role="status" className="text-sm text-secondary">
              {state.movedTo ? `Saved. The next check searches from ${state.movedTo}.` : "Saved."}
            </span>
          )}
        </div>
        {hint && <p className="text-xs text-muted">{hint}</p>}
      </div>
    </form>
  );
}
