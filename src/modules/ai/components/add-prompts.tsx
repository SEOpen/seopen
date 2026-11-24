"use client";

import { useMemo, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input, Select, Textarea } from "@/components/ui/input";
import { RefusalText } from "@/components/ui/refusal-text";
import { SpendConfirm } from "@/components/ui/spend-confirm";
import { formatNumber, formatUsd } from "@/lib/format";
import { addPrompts, suggestPrompts, type Suggestion } from "../actions";
import { PLATFORMS } from "../platforms";
import { maxCostLabel } from "@/modules/keywords/format";
import { monthlyCost, promptToKeyword, roundUsd, runCost, SUGGEST_MAX_USD, type CostRates } from "../prompts";

function PlatformPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap gap-3 text-sm">
      {PLATFORMS.map((p) => (
        <label key={p.key} className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="accent-[var(--accent-fill)]"
            checked={value.includes(p.key)}
            onChange={(e) => onChange(e.target.checked ? [...value, p.key] : value.filter((k) => k !== p.key))}
          />
          {p.label}
        </label>
      ))}
    </div>
  );
}

/** The cost line shown before anything is added: per run and per month at the weekly schedule. */
function CostLine({
  items,
  rates,
  currentMonthly,
  fixedMonthly,
}: {
  items: { platforms: string[]; keyword: string | null }[];
  rates: CostRates;
  currentMonthly: number;
  fixedMonthly: number;
}) {
  if (!items.length) return null;
  const monthly = monthlyCost(items, rates) + fixedMonthly;
  return (
    <p className="text-xs text-muted">
      Adds ≈ <span className="font-medium text-fg">{formatUsd(roundUsd(monthly))}/month</span> ({formatUsd(roundUsd(runCost(items, rates)))} per weekly run, AI Overview check
      included{fixedMonthly ? `, plus ${formatUsd(roundUsd(fixedMonthly))}/month for the weekly mentions check` : ""}). Total for this project becomes ≈ {formatUsd(roundUsd(currentMonthly + monthly))}/month.
    </p>
  );
}

export function AddPrompts({
  projectId,
  rates,
  currentMonthly,
  fixedMonthly,
  ownDomains,
  topics,
  showCost,
  suggestRefused = null,
}: {
  projectId: number;
  rates: CostRates;
  currentMonthly: number;
  /** Fixed monthly cost that starts with the first prompt (the weekly LLM Mentions task). */
  fixedMonthly: number;
  /** Our domains (project domain first, then alias domains); suggestions can come from any of them. */
  ownDomains: string[];
  /** Topics already used on the project, offered in the topic field. */
  topics: string[];
  /** Dollar estimates are for the owner's workspace; a plan covers AI checks for customers. */
  showCost: boolean;
  /** Why Suggest prompts can't spend now (out of research credits, or the spend ceiling), so it's off with this as its title. */
  suggestRefused?: string | null;
}) {
  const [text, setText] = useState("");
  const [topic, setTopic] = useState("");
  const [fromDomain, setFromDomain] = useState(ownDomains[0]);
  const [platforms, setPlatforms] = useState<string[]>(PLATFORMS.map((p) => p.key));
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const manual = useMemo(
    () =>
      text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length >= 3)
        .map((prompt) => ({ prompt, keyword: promptToKeyword(prompt) || null, source: "manual" as const, topic: topic || null })),
    [text, topic],
  );
  // A suggestion keeps its own topic; the topic field fills the ones without.
  const chosen = (suggestions ?? [])
    .filter((s) => picked.has(s.prompt))
    .map((s) => ({ prompt: s.prompt, keyword: s.promptKeyword, source: "suggested" as const, topic: s.topic ?? (topic || null) }));
  const items = [...manual, ...chosen];
  const costItems = items.map((i) => ({ platforms, keyword: i.keyword }));

  const add = () =>
    start(async () => {
      setError(null);
      try {
        const refused = await addPrompts(projectId, items, platforms);
        if (refused) {
          setError(refused.error);
          return;
        }
        setText("");
        setPicked(new Set());
        setSuggestions((s) => s?.filter((x) => !picked.has(x.prompt)) ?? null);
      } catch {
        // Next hides a thrown message in production, so there's nothing more to say about why.
        setError("Those prompts couldn't be added. Try again.");
      }
    });

  // The most the lookups can cost; a week's saved result costs nothing, so it says "max".
  const suggestPrice = maxCostLabel(SUGGEST_MAX_USD);
  const suggest = () =>
    start(async () => {
      setError(null);
      const res = await suggestPrompts(projectId, fromDomain);
      if (res.error) setError(res.error);
      setSuggestions(res.suggestions);
    });

  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <label htmlFor="ai-prompts" className="text-xs font-medium text-muted">
          Prompts, one per line
        </label>
        <Textarea
          id="ai-prompts"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </div>

      <div className="grid gap-2 @2xl/main:max-w-xs">
        <label htmlFor="ai-topic" className="text-xs font-medium text-muted">
          Topic (optional)
        </label>
        <Input id="ai-topic" value={topic} onChange={(e) => setTopic(e.target.value)} list="ai-topic-list" maxLength={60} />
        <datalist id="ai-topic-list">
          {topics.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <PlatformPicker value={platforms} onChange={setPlatforms} />
        <div className="flex flex-wrap items-center gap-2">
          {ownDomains.length > 1 && (
            <Select aria-label="Suggest from domain" className="h-8 w-auto max-w-full text-xs" value={fromDomain} onChange={(e) => setFromDomain(e.target.value)}>
              {ownDomains.map((d) => (
                <option key={d} value={d}>
                  from {d}
                </option>
              ))}
            </Select>
          )}
          {/* A research lookup, and the prompts field is what this form is for: it shows its price and asks first. */}
          <form action={suggest}>
            <SpendConfirm pending={pending} disabled={!!suggestRefused} title={suggestRefused ?? undefined} confirmLabel="Suggest" question={`Look up the keywords ${fromDomain} ranks for, ${suggestPrice}${showCost ? ` (${formatUsd(SUGGEST_MAX_USD)} at most)` : ""}?`}>
              {pending && !suggestions ? "Finding…" : `Suggest prompts (${suggestPrice})`}
            </SpendConfirm>
          </form>
        </div>
      </div>

      {suggestions && (
        <div className="rounded-md border border-line">
          <div className="flex items-center justify-between border-b border-line px-3 py-2 text-xs text-muted">
            <span>
              {suggestions.length
                ? `${suggestions.length} questions from keywords ${fromDomain} ranks for`
                : `No unbranded keywords found for ${fromDomain} yet.`}
            </span>
            {suggestions.length > 0 && (
              <button
                type="button"
                className="text-accent underline-offset-3 hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => setPicked(picked.size === suggestions.length ? new Set() : new Set(suggestions.map((s) => s.prompt)))}
              >
                {picked.size === suggestions.length ? "Select none" : "Select all"}
              </button>
            )}
          </div>
          <ul className="max-h-72 divide-y divide-line overflow-y-auto text-sm">
            {suggestions.map((s) => (
              <li key={s.prompt}>
                <label className="flex cursor-pointer items-start gap-2 px-3 py-2 hover:bg-surface-2/60">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--accent-fill)]"
                    checked={picked.has(s.prompt)}
                    onChange={(e) => {
                      const next = new Set(picked);
                      if (e.target.checked) next.add(s.prompt);
                      else next.delete(s.prompt);
                      setPicked(next);
                    }}
                  />
                  <span className="flex-1">
                    {s.prompt}
                    <span className="block text-xs text-muted">
                      from “{s.keyword}” · {formatNumber(s.volume)}/mo searches
                      {s.topic && <> · topic: {s.topic}</>}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <Callout tone="bad" role="alert">
          <RefusalText text={error} />
        </Callout>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={add} disabled={pending || !items.length || !platforms.length}>
          Add {items.length || ""} prompt{items.length === 1 ? "" : "s"}
        </Button>
        {showCost && <CostLine items={costItems} rates={rates} currentMonthly={currentMonthly} fixedMonthly={fixedMonthly} />}
      </div>
    </div>
  );
}
