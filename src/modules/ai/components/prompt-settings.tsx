"use client";

import { useState, useTransition } from "react";
import { ActionProblem } from "@/components/ui/action-form";
import { Button } from "@/components/ui/button";
import { ConfirmSubmit } from "@/components/ui/confirm-submit";
import { Input, Label } from "@/components/ui/input";
import type { ActionRefusal } from "@/lib/action-result";
import { formatUsd } from "@/lib/format";
import { deletePrompt, setPromptActive, updatePrompt } from "../actions";
import { PLATFORMS } from "../platforms";
import { monthlyCost, roundUsd, type CostRates } from "../prompts";

/** Edit a prompt's topic, platforms and AI Overview keyword, pause or delete it. The owner's workspace also sees the edited setup's monthly cost. */
export function PromptSettings({
  projectId,
  prompt,
  topics,
  rates,
  showCost,
}: {
  projectId: number;
  prompt: { id: number; keyword: string | null; topic: string | null; platforms: string[]; active: boolean };
  /** Topics already used on the project, offered in the topic field. */
  topics: string[];
  rates: CostRates;
  showCost: boolean;
}) {
  const [platforms, setPlatforms] = useState(prompt.platforms);
  const [keyword, setKeyword] = useState(prompt.keyword ?? "");
  const [topic, setTopic] = useState(prompt.topic ?? "");
  const [pending, start] = useTransition();
  const [refusal, setRefusal] = useState<ActionRefusal | null>(null);
  const dirty =
    keyword !== (prompt.keyword ?? "") ||
    topic.trim() !== (prompt.topic ?? "") || platforms.slice().sort().join() !== prompt.platforms.slice().sort().join();
  const monthly = monthlyCost([{ platforms, keyword: keyword || null }], rates);

  return (
    <div className="grid gap-4">
      <div className="grid gap-2 text-sm">
        <span className="text-xs font-medium text-muted">Platforms</span>
        {PLATFORMS.map((p) => (
          <label key={p.key} className="flex items-center gap-2">
            <input
              type="checkbox"
              className="accent-[var(--accent-fill)]"
              checked={platforms.includes(p.key)}
              onChange={(e) => setPlatforms(e.target.checked ? [...platforms, p.key] : platforms.filter((k) => k !== p.key))}
            />
            {p.label} <span className="text-xs text-muted">{p.model}</span>
          </label>
        ))}
      </div>
      <Label>
        Topic
        <Input value={topic} onChange={(e) => setTopic(e.target.value)} list="ai-prompt-topics" maxLength={60} placeholder="No topic" />
        <datalist id="ai-prompt-topics">
          {topics.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
      </Label>
      <Label>
        AI Overview keyword (empty skips the check)
        <Input value={keyword} onChange={(e) => setKeyword(e.target.value)} maxLength={200} />
      </Label>
      {showCost && <p className="text-xs text-muted">≈ {formatUsd(roundUsd(monthly))}/month at the weekly schedule.</p>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!dirty || pending || !platforms.length} onClick={() => start(() => updatePrompt(projectId, prompt.id, { keyword: keyword || null, platforms, topic: topic.trim() || null }))}>
          Save
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setRefusal((await setPromptActive(projectId, prompt.id, !prompt.active)) ?? null);
            })
          }
        >
          {prompt.active ? "Pause" : "Resume"}
        </Button>
        <form action={() => start(() => deletePrompt(projectId, prompt.id))}>
          <ConfirmSubmit variant="danger" pending={pending} confirmLabel="Delete" question="Delete this prompt and all its stored answers?">
            Delete
          </ConfirmSubmit>
        </form>
      </div>
      <ActionProblem result={refusal} />
    </div>
  );
}
