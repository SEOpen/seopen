"use client";

import { Check, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { useTimeZone } from "@/components/time-zone";
import { Button, ButtonLink } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Select, Textarea } from "@/components/ui/input";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { formatNumber, formatUsd } from "@/lib/format";
import { zonedJobTime } from "@/lib/schedule";
import { FindListingForm } from "@/modules/local/components/forms";
import { rules } from "@/plan-policy/rules";
import { applySetup, proposeSetup, quoteBusiness, readBusiness, type BusinessRead, type ProposeResult } from "../actions";
import type { SetupStep, StepResult } from "../apply";
import { BUSINESS_LABELS, BUSINESS_TYPES, MAX_SEARCHES, MAX_TOWNS, parseSearches, parseTowns, type BusinessType, type SetupBusiness } from "../business";
import type { SetupQuote, SetupState } from "../gather";
import type { Proposal, ProposedKeyword } from "../propose";

const STEP_LABELS: Record<SetupStep, string> = {
  city: "City for Rankings",
  competitors: "Competitors",
  keywords: "Rankings",
  prompts: "AI visibility",
  rank: "Rankings check",
  ai: "AI visibility run",
  audit: "Site audit",
};

/** Where each step's results show. Project links skip prefetch: proxy.ts treats a visit as picking the project. */
const stepHref = (projectId: number): Record<SetupStep, string> => ({
  city: `/projects/${projectId}/settings`,
  competitors: `/projects/${projectId}/settings`,
  keywords: "/rank",
  prompts: "/ai",
  rank: "/rank",
  ai: "/ai",
  audit: "/audit",
});

type Checks = { rank: boolean; ai: boolean; audit: boolean };

const plural = (n: number, word: string) => `${formatNumber(n)} ${word}${n === 1 ? "" : "s"}`;

/** What a paid proposal's card says about its price. */
const SETUP_PRICE_LINE = rules.hasPlans ? " Research credits come with your plan every month, so this adds nothing to your bill." : " The price is what its lookups cost at DataForSEO.";

/** The First checks card's line: when each runs on its own, and what starting it now counts against. */
export const firstChecksLine = (rankTime: string) =>
  `Start these now instead of waiting for the schedule: rankings are checked every day at ${rankTime} and AI prompts every week. ${rules.hasPlans ? "They're included in your plan, within its limits." : "They count against the workspace's monthly DataForSEO cap."}`;

const cleanKeyword = (k: string) => k.toLowerCase().replace(/\s+/g, " ").trim();

const QUOTE_AFTER_TYPING_MS = 400;

/** The answer the boxes add up to, for one type: each type uses its own box and leaves the other's text in place. */
const answerFrom = (type: BusinessType, towns: string, searches: string): SetupBusiness => ({
  type,
  towns: type === "local" ? parseTowns(towns) : [],
  searches: type === "local" ? [] : parseSearches(searches),
});

/** `next`, trimmed to `max` items: what was already picked stays, then the new picks in order. */
function capPick(prev: Set<string>, next: Set<string>, max: number): Set<string> {
  if (next.size <= max) return next;
  const kept = new Set([...prev].filter((k) => next.has(k)));
  for (const k of next) {
    if (kept.size >= max) break;
    kept.add(k);
  }
  return kept;
}

/** A checklist section: a switch for the whole section, then one tickable row per item. */
function Checklist<T>({
  title,
  description,
  items,
  keyOf,
  picked,
  onPick,
  render,
  empty,
  full = false,
  footer,
}: {
  title: string;
  description: string;
  items: T[];
  keyOf: (item: T) => string;
  picked: Set<string>;
  onPick: (next: Set<string>) => void;
  render: (item: T) => ReactNode;
  empty: string;
  /** No room for more: rows that aren't ticked can't be. */
  full?: boolean;
  footer?: ReactNode;
}) {
  const all = items.length > 0 && items.every((i) => picked.has(keyOf(i)));
  return (
    <Card>
      <CardHeader
        title={title}
        description={description}
        actions={
          items.length > 0 && (
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <input
                type="checkbox"
                className="accent-[var(--accent-fill)]"
                checked={all}
                onChange={() => onPick(all ? new Set() : new Set([...picked, ...items.map(keyOf)]))}
              />
              Include
            </label>
          )
        }
      />
      {items.length ? (
        <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
          {items.map((item) => {
            const key = keyOf(item);
            const disabled = full && !picked.has(key);
            return (
              <li key={key}>
                <label className={`flex items-start gap-2 px-4 py-2 ${disabled ? "opacity-60" : "cursor-pointer hover:bg-surface-2/60"}`}>
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--accent-fill)]"
                    checked={picked.has(key)}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      onPick(next);
                    }}
                  />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{render(item)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      ) : (
        <CardBody className="text-sm text-muted">{empty}</CardBody>
      )}
      {footer && <CardBody className="border-t border-line">{footer}</CardBody>}
    </Card>
  );
}

const ROW_SOURCES: Record<NonNullable<ProposedKeyword["source"]>, string> = {
  homepage: "from your homepage",
  search: "your search",
  unknown: "no data from Google",
};

function KeywordRow({ k }: { k: ProposedKeyword }) {
  return (
    <span className="flex flex-wrap items-baseline justify-between gap-x-3">
      <span className="min-w-0">
        {k.keyword}
        {k.tag && <span className="ml-2 text-xs text-muted">{k.tag}</span>}
      </span>
      <span className="shrink-0 text-xs text-muted">{k.volume != null ? `${formatNumber(k.volume)} searches/mo` : k.source ? ROW_SOURCES[k.source] : "added by you"}</span>
    </span>
  );
}

/** What the project tracks now, with where to see it: a return visit starts here. */
function CurrentSetup({ projectId, state }: { projectId: number; state: SetupState }) {
  const href = stepHref(projectId);
  const rows: [string, string][] = [
    [plural(state.keywords, "keyword") + " in Rankings", href.keywords],
    [plural(state.prompts, "AI prompt"), href.prompts],
    [plural(state.competitors, "competitor"), href.competitors],
    ["Site audit", href.audit],
  ];
  return (
    <Card className="self-start">
      <CardHeader title="Set up so far" description="What this project tracks now. First checks show their results on these pages as they arrive." />
      <ul className="divide-y divide-line text-sm">
        {rows.map(([label, to]) => (
          <li key={label}>
            <Link href={to} prefetch={to.startsWith("/projects/") ? false : undefined} className="flex justify-between gap-3 px-4 py-2.5 hover:bg-surface-2/60">
              <span>{label}</span>
              <span className="text-xs text-accent">View</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The guided setup: make a proposal (quoted research credits), review it as
 * a checklist where every item can be dropped and keyword ideas or the user's own keywords added,
 * then apply what's ticked. Nothing changes before Apply.
 */
export function SetupWizard({ projectId, domain, state }: { projectId: number; domain: string; state: SetupState }) {
  const timeZone = useTimeZone();
  const [known, setKnown] = useState<BusinessRead | null>(null);
  const [type, setType] = useState<BusinessType>("other");
  const [townsText, setTownsText] = useState("");
  const [searchesText, setSearchesText] = useState("");
  const [quote, setQuote] = useState<SetupQuote | null>(null);
  const [, startQuote] = useTransition();
  const [priceRose, setPriceRose] = useState(false);
  const [city, setCity] = useState<number | null>(null);
  const [result, setResult] = useState<ProposeResult | null>(null);
  const [competitors, setCompetitors] = useState<Set<string>>(new Set());
  const [keywords, setKeywords] = useState<Set<string>>(new Set());
  const [ideas, setIdeas] = useState<Set<string>>(new Set());
  const [own, setOwn] = useState<ProposedKeyword[]>([]);
  const [ownText, setOwnText] = useState("");
  const [prompts, setPrompts] = useState<Set<string>>(new Set());
  const [checks, setChecks] = useState<Checks>({ rank: true, ai: true, audit: true });
  const [applied, setApplied] = useState<StepResult[] | null>(null);
  const [pending, start] = useTransition();

  const answerFor = (t: BusinessType): SetupBusiness => answerFrom(t, townsText, searchesText);
  const business = answerFor(type);
  /** The latest price asked for, and which answer it's for. The latest ask wins, whichever comes back last. */
  const lastQuote = useRef<{ answer: string; price: Promise<SetupQuote> } | null>(null);
  const priceOf = (next: SetupBusiness) => {
    const answer = JSON.stringify(next);
    if (lastQuote.current?.answer !== answer) lastQuote.current = { answer, price: quoteBusiness(projectId, next) };
    return lastQuote.current.price;
  };
  const requote = (next: SetupBusiness) => {
    if (lastQuote.current?.answer === JSON.stringify(next)) return;
    setPriceRose(false);
    startQuote(async () => {
      const price = priceOf(next);
      const fresh = await price;
      if (lastQuote.current?.price === price) setQuote(fresh);
    });
  };

  const makeProposal = async (answer: SetupBusiness) => {
    const res = await proposeSetup(projectId, answer);
    setResult(res);
    if (!res.proposal) return;
    // What's been looked up is free now, so the next price has to be asked for.
    lastQuote.current = null;
    setCompetitors(new Set(res.proposal.competitors.map((c) => c.domain)));
    setKeywords(new Set(res.proposal.keywords.map((k) => k.keyword)));
    // The ideas with a source are the most about this business, so they start ticked, in
    // whatever room the ranked keywords leave. A search Google doesn't know may be a slogan.
    const sourced = res.proposal.ideas.filter((k) => k.source && k.source !== "unknown").map((k) => k.keyword);
    setIdeas(capPick(new Set(), new Set(sourced), Math.max(0, res.proposal.keywordRoom - res.proposal.keywords.length)));
    setOwn([]);
    setPrompts(new Set(res.proposal.prompts.map((p) => p.prompt)));
    setChecks({ rank: true, ai: res.proposal.prompts.length > 0, audit: true });
    setCity(res.proposal.trackingCities?.[0]?.code ?? null);
  };

  /** A click never spends more than the button said: if the answer changed its price just now, the new price shows and nothing is spent. */
  const propose = () =>
    start(async () => {
      const shown = quote?.credits ?? 0;
      const fresh = await priceOf(business);
      setQuote(fresh);
      setPriceRose(fresh.credits > shown);
      if (fresh.credits > shown) setResult(null); // An earlier error isn't about this answer.
      else await makeProposal(business);
    });

  // The first guess is free but takes a moment, so the page opens without waiting for it. Coming
  // back before Apply: when the user has answered and the lookups are already paid for, the proposal
  // costs nothing to make again, so it's shown straight away instead of asking for the same click twice.
  const opened = useRef(false);
  const setUp = state.keywords + state.prompts + state.competitors > 0;
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    start(async () => {
      const read = await readBusiness(projectId);
      const towns = read.business.towns.join("\n");
      const searches = read.business.searches.join("\n");
      lastQuote.current = { answer: JSON.stringify(answerFrom(read.business.type, towns, searches)), price: Promise.resolve(read.quote) };
      setKnown(read);
      setType(read.business.type);
      setTownsText(towns);
      setSearchesText(searches);
      setQuote(read.quote);
      if (read.confirmed && !setUp && read.quote.credits === 0) await makeProposal(read.business);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on opening
  }, []);

  // The price follows the typing, so it's already right when the person reaches the button. It used to
  // be asked for when the box lost focus, which the click on the button itself caused: the button
  // went disabled under the mouse and the click was lost.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (known) requote(business);
    }, QUOTE_AFTER_TYPING_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the text starts this: a type change asks for itself
  }, [townsText, searchesText]);

  const proposal: Proposal | undefined = result?.proposal;
  const room = proposal?.keywordRoom ?? 0;
  const pickKeywords = (next: Set<string>) => setKeywords(capPick(keywords, next, room - ideas.size));
  const pickIdeas = (next: Set<string>) => setIdeas(capPick(ideas, next, room - keywords.size));

  /** Adds typed keywords: one already offered is ticked, a new one joins the list ticked. */
  const addOwn = (e: FormEvent) => {
    e.preventDefault();
    if (!proposal) return;
    const typed = [...new Set(ownText.split(/[\n,]/).map(cleanKeyword))].filter((k) => k && k.length <= 200);
    const ideaKeys = new Set(proposal.ideas.map((k) => k.keyword));
    const listed = new Set([...proposal.keywords, ...own].map((k) => k.keyword));
    const fresh = typed.filter((k) => !ideaKeys.has(k) && !listed.has(k));
    const nextIdeas = capPick(ideas, new Set([...ideas, ...typed.filter((k) => ideaKeys.has(k))]), room - keywords.size);
    setIdeas(nextIdeas);
    setOwn([...own, ...fresh.map((keyword) => ({ keyword, volume: null, tag: null }))]);
    setKeywords(capPick(keywords, new Set([...keywords, ...typed.filter((k) => !ideaKeys.has(k))]), room - nextIdeas.size));
    setOwnText("");
  };

  const apply = () =>
    start(async () => {
      if (!proposal) return;
      const chosen = [...proposal.keywords, ...own].filter((k) => keywords.has(k.keyword)).concat(proposal.ideas.filter((k) => ideas.has(k.keyword)));
      const asked = proposal.prompts.filter((p) => prompts.has(p.prompt));
      const { results } = await applySetup(projectId, {
        competitors: proposal.competitors.filter((c) => competitors.has(c.domain)).map((c) => c.domain),
        competitorNames: Object.fromEntries(proposal.competitors.filter((c) => competitors.has(c.domain) && c.name).map((c) => [c.domain, c.name as string])),
        keywords: chosen.map((k) => ({ keyword: k.keyword, tag: k.tag })),
        prompts: asked,
        // A check with nothing to check is left out, as its unticked box shows.
        checks: { rank: checks.rank && chosen.length > 0, ai: checks.ai && asked.length > 0, audit: checks.audit },
        city,
      });
      setApplied(results);
    });

  if (applied) {
    const href = stepHref(projectId);
    return (
      // One column, not a side rail: the listing form sets its columns by the page's width, so a rail would squeeze it.
      <div className="grid max-w-2xl gap-6">
        <Card>
          <CardHeader title="Set up" description="What was added and started, and where to see it. Anything that didn't go through says why." />
          <ul className="divide-y divide-line text-sm">
            {applied.map((r) => (
              <li key={r.step} className="flex items-start gap-3 px-4 py-2.5">
                {r.ok ? <Check aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-secondary" /> : <X aria-hidden strokeWidth={1.5} className="mt-0.5 size-4 shrink-0 text-bad" />}
                <span className="min-w-0 flex-1">
                  <span className="sr-only">{r.ok ? "Done: " : "Didn't go through: "}</span>
                  <span className="font-medium">{STEP_LABELS[r.step]}</span>
                  <span className="block text-xs text-muted">{r.message}</span>
                </span>
                {r.ok && (
                  <Link href={href[r.step]} prefetch={href[r.step].startsWith("/projects/") ? false : undefined} className="shrink-0 text-xs text-accent hover:underline">
                    View
                  </Link>
                )}
              </li>
            ))}
            {!applied.length && <li className="px-4 py-2.5 text-muted">Nothing was ticked, so nothing changed.</li>}
          </ul>
          <CardBody className="flex flex-wrap gap-2 border-t border-line">
            <ButtonLink href={`/projects/${projectId}`} prefetch={false}>
              Go to Overview
            </ButtonLink>
            <ButtonLink href="/gsc" variant="secondary">
              Connect Search Console
            </ButtonLink>
          </CardBody>
        </Card>
        {proposal?.local && (
          <Card>
            <CardHeader
              title="Next: your Google Maps listing"
              description={`Find ${proposal.local.name}'s listing in ${proposal.local.city} to track it in Local SEO.`}
            />
            <CardBody>
              <FindListingForm projectId={projectId} showUsd={quote?.usd != null} defaultName={proposal.local.name} defaultCity={proposal.local.city} />
            </CardBody>
          </Card>
        )}
      </div>
    );
  }

  if (!proposal) {
    // Short enough to stay on one line in a phone-width card. The dollar figure is null for customers,
    // and left out without plans, where the price is dollars already.
    const usd = quote?.usd != null ? formatUsd(quote.usd, 3) : null;
    const cost = !quote ? null : quote.credits ? (rules.hasPlans ? `≈ ${plural(quote.credits, "credit")}${usd ? `, ${usd}` : ""}` : `≈ ${rules.creditsText(quote.credits)}`) : "free";
    const reads =
      type === "local"
        ? "the keywords it ranks for in Google, keyword ideas for it and who's at the top of Google Maps in the towns below"
        : "the keywords it ranks for in Google, keyword ideas for it and the searches below, and the sites that rank for them";
    const needsTown = type === "local" && !business.towns.length;
    const review = quote?.review;
    const reviewLine = !review
      ? ""
      : review.free
        ? ` Claude then reviews the proposal for free${review.of != null ? `: ${review.left} of ${review.of} free reviews left this month` : ""}.`
        : ` Claude then reviews the proposal. This month's ${review.of} free reviews are used, so this one is in the ${rules.hasPlans ? "credits" : "price"} shown.`;
    return (
      <div className={setUp ? "module-rail max-w-2xl @5xl/main:max-w-5xl" : "max-w-2xl"}>
        <Card className="self-start">
          <CardHeader
            title={setUp ? "Make a new proposal" : "Make a proposal"}
            description={`Reads ${domain}'s homepage, ${reads}, then suggests what to track. ${setUp ? "It leaves out what the project tracks already. " : ""}Nothing changes until you apply it.${quote ? (quote.credits ? SETUP_PRICE_LINE : " This one is free, because the data is already here.") : ""}${reviewLine}`}
          />
          <CardBody className="flex flex-col items-start gap-4">
            {!known ? (
              <p role="status" className="text-sm text-muted">
                Reading the homepage to see what kind of business this is…
              </p>
            ) : (
              <>
                <fieldset className="w-full">
                  <legend className="text-sm font-medium">What kind of business is this?</legend>
                  <p className="mt-0.5 text-xs text-muted">
                    {known.confirmed
                      ? "Your answer from last time."
                      : known.read
                        ? "Our guess from the homepage. Change it if it's wrong: competitors, keywords and prompts all depend on it."
                        : "We couldn't read the homepage, so pick what fits."}
                  </p>
                  <div className="mt-2 grid gap-2 @2xl/main:grid-cols-2">
                    {BUSINESS_TYPES.map((t) => (
                      <label key={t} className={`flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm ${type === t ? "border-accent" : "border-line hover:bg-surface-2/60"}`}>
                        <input
                          type="radio"
                          name="business-type"
                          className="mt-1 accent-[var(--accent-fill)]"
                          checked={type === t}
                          onChange={() => {
                            setType(t);
                            requote(answerFor(t));
                          }}
                        />
                        <span className="min-w-0">
                          {BUSINESS_LABELS[t].label}
                          <span className="block text-xs text-muted">{BUSINESS_LABELS[t].hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                {type !== "local" && (
                  <div className="w-full">
                    <label htmlFor="setup-searches" className="text-sm font-medium">
                      What do people search for to find you?
                    </label>
                    <p className="mt-0.5 text-xs text-muted">
                      One per line, up to {MAX_SEARCHES}, in the words a customer would type.
                      {known.confirmed ? " " : " Our guess from your site, so change anything that's off. "}
                      Competitors, keyword ideas and prompts all start from these.
                    </p>
                    <Textarea
                      id="setup-searches"
                      className="mt-2"
                      rows={3}
                      value={searchesText}
                      onChange={(e) => setSearchesText(e.target.value)}
                    />
                  </div>
                )}
                {type === "local" && (
                  <div className="w-full">
                    <label htmlFor="setup-towns" className="text-sm font-medium">
                      Towns it serves
                    </label>
                    <p className="mt-0.5 text-xs text-muted">One per line, main town first, up to {MAX_TOWNS}. The first three are searched on Google Maps. Adding the state helps: Riverton, Ohio.</p>
                    <Textarea
                      id="setup-towns"
                      className="mt-2"
                      rows={3}
                      value={townsText}
                      onChange={(e) => setTownsText(e.target.value)}
                    />
                  </div>
                )}
              </>
            )}
            {/* The form holds only the button, so Enter in a field above can't spend. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                propose();
              }}
            >
              <SpendConfirm
                // One click on a first visit or when it's free. Coming back to a project that's set up, a paid proposal asks first.
                first={!setUp || !quote?.credits}
                pending={pending || !known || needsTown}
                question={`Use ≈ ${rules.creditsText(quote?.credits ?? 0)} on a new proposal?`}
                confirmLabel="Make a proposal"
              >
                {pending && known ? "Reading the site…" : cost ? `Make a proposal (${cost})` : "Make a proposal"}
              </SpendConfirm>
            </form>
            {needsTown && <p className="text-xs text-muted">Name at least one town, so the proposal can find who you compete with there.</p>}
            {priceRose && !pending && (
              <p role="status" className="text-xs text-muted">
                Your answer changed the price, so nothing was spent yet. The button shows the new price.
              </p>
            )}
            {result?.error && <Callout tone="bad" role="alert" title={result.error} />}
          </CardBody>
        </Card>
        {setUp && <CurrentSetup projectId={projectId} state={state} />}
      </div>
    );
  }

  const cities = proposal.trackingCities ?? [];
  const picked = keywords.size + ideas.size;
  const full = picked >= room;
  const count = { competitors: competitors.size, keywords: picked, prompts: prompts.size };
  const startable = { rank: count.keywords > 0, ai: count.prompts > 0, audit: true };
  const started = (Object.keys(checks) as (keyof Checks)[]).filter((k) => checks[k] && startable[k]).length;
  const summary = [
    count.competitors && plural(count.competitors, "competitor"),
    count.keywords && plural(count.keywords, "keyword"),
    count.prompts && plural(count.prompts, "AI prompt"),
  ].filter(Boolean);
  const roomLine = room
    ? `${formatNumber(picked)} of ${plural(room, "keyword")} picked${full ? ". That's all this Apply can add, so untick one to pick another." : "."}`
    : "Your plan has no room for more keywords.";

  return (
    <div className="grid max-w-5xl gap-6 [&>*]:min-w-0">
      {(result?.read || result?.homepageError) && (
        <Callout title={result.read?.title ?? domain}>
          {result.read?.description ?? `Couldn't read the homepage: ${result.homepageError} The proposal uses Google's data only.`}
        </Callout>
      )}
      {result?.claude && (
        <p className="text-sm text-muted">{"error" in result.claude ? result.claude.error : `Reviewed by Claude${result.claude.summary ? `: ${result.claude.summary}` : "."}`}</p>
      )}
      {proposal.notes.length > 0 && (
        <Callout tone="warn">
          <ul className="list-disc pl-4">
            {proposal.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Callout>
      )}

      <p className="flex flex-wrap items-baseline gap-x-2 text-sm text-muted">
        <span>
          Proposed for {type === "local" && business.towns.length ? `a local business in ${business.towns.join("; ")}` : `this type of business: ${BUSINESS_LABELS[type].label.toLowerCase()}`}.
        </span>
        <button
          type="button"
          className="min-h-6 rounded-sm text-xs text-accent hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
          onClick={() => {
            setResult(null);
            requote(business);
          }}
        >
          Change
        </button>
      </p>

      <div className="grid items-start gap-6 @3xl/main:grid-cols-2 [&>*]:min-w-0">
        <Checklist
          title="Competitors"
          description={
            type === "local"
              ? "The businesses at the top of Google Maps for your service in your towns. Rank tracking and AI visibility compare you with them."
              : "Sites your comparison page names, then sites in Google's results for the searches your business wants, brand searches left out. Rank tracking and AI visibility compare you with them."
          }
          items={proposal.competitors}
          keyOf={(c) => c.domain}
          picked={competitors}
          onPick={setCompetitors}
          render={(c) => (
            <>
                {c.domain}
                <span className="block text-xs text-muted">{c.reason}</span>
            </>
          )}
          empty={
            proposal.trackedCompetitors.length
              ? `Already tracking ${proposal.trackedCompetitors.join(", ")}. Google had no others to suggest.`
              : "No competitors to suggest. You can add the ones you know in Project settings."
          }
          footer={
            proposal.trackedCompetitors.length > 0 &&
            proposal.competitors.length > 0 && <p className="text-xs text-muted">Already tracking {proposal.trackedCompetitors.join(", ")}.</p>
          }
        />
        <Checklist
          title="AI visibility prompts"
          description="Questions asked weekly on ChatGPT, Perplexity, Gemini and Claude, to see whether they mention you."
          items={proposal.prompts}
          keyOf={(p) => p.prompt}
          picked={prompts}
          onPick={setPrompts}
          render={(p) => (
            <>
                {p.prompt}
                <span className="block text-xs text-muted">
                  from “{p.keyword}”{p.topic ? ` · topic ${p.topic}` : ""}
                </span>
            </>
          )}
          empty="No unbranded keywords to turn into questions yet."
        />
      </div>

      <div className="grid items-start gap-6 @3xl/main:grid-cols-2 [&>*]:min-w-0">
        <Checklist
          title="Rankings"
          description={`Keywords you already rank for, by monthly searches, and any you add. Checked daily. ${roomLine}`}
          items={[...proposal.keywords, ...own]}
          keyOf={(k) => k.keyword}
          picked={keywords}
          onPick={pickKeywords}
          full={full}
          render={(k) => <KeywordRow k={k} />}
          empty={
            proposal.rankedKeywords > 0
              ? "The keywords this site ranks for are already tracked or were left out. Pick from the ideas, or add your own below."
              : "The site doesn't rank for keywords Google reports yet. Pick from the ideas, or add your own below."
          }
          footer={
            <>
              {cities.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent-fill)]"
                      checked={city != null}
                      onChange={(e) => setCity(e.target.checked ? cities[0].code : null)}
                    />
                    Search from
                  </label>
                  <Select value={city ?? cities[0].code} onChange={(e) => setCity(Number(e.target.value))} disabled={city == null} aria-label="City to search from" className="w-auto max-w-full min-w-0">
                    {cities.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                  <p className="w-full text-xs text-muted">Rankings then show what people there see, instead of the whole country. You can change this in Project settings.</p>
                </div>
              )}
              <form onSubmit={addOwn} className="flex items-start gap-2">
                <Textarea
                  value={ownText}
                  onChange={(e) => setOwnText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
                  }}
                  rows={2}
                  placeholder="Add your own: one per line, or separated by commas"
                  aria-label="Keywords to add"
                  disabled={!room}
                  className="min-w-0"
                />
                <Button type="submit" variant="secondary" disabled={!room || !ownText.trim()} className="shrink-0">
                  Add
                </Button>
              </form>
            </>
          }
        />
        <Checklist
          title="Keyword ideas"
          description={
            proposal.local
              ? "Keywords you don't rank for yet: your homepage's services in the towns you serve, then Google's ideas that name your towns. The homepage ones start ticked."
              : "Keywords you don't rank for yet. The searches you named and what Google knows that contains them start ticked. Then what Google relates to your site."
          }
          items={proposal.ideas}
          keyOf={(k) => k.keyword}
          picked={ideas}
          onPick={pickIdeas}
          full={full}
          render={(k) => <KeywordRow k={k} />}
          empty="No new keyword ideas for this site. Add your own under Rankings."
        />
      </div>

      <Card>
        <CardHeader
          title="First checks"
          description={firstChecksLine(zonedJobTime("06:00", timeZone))}
        />
        <CardBody className="flex flex-col gap-2 text-sm">
          {(
            [
              ["rank", "Check rankings now"],
              ["ai", "Ask the AI platforms now"],
              ["audit", "Crawl the site now"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="flex items-center gap-2">
              <input
                type="checkbox"
                className="accent-[var(--accent-fill)]"
                checked={checks[key] && startable[key]}
                disabled={!startable[key]}
                onChange={(e) => setChecks({ ...checks, [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={apply} disabled={pending}>
          {pending ? "Setting up…" : "Apply"}
        </Button>
        <p className="text-xs text-muted">
          {summary.length ? `Adds ${summary.join(", ")}` : "Adds nothing"}
          {started ? `, and starts ${plural(started, "check")}.` : "."}
        </p>
      </div>
    </div>
  );
}
