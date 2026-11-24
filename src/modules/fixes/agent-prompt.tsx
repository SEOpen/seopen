"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** What to paste into a coding agent that's connected to SEOpen, with a button that copies it. */
export function AgentPrompt({ prompt }: { prompt: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <code className="block w-full rounded-sm bg-surface-2 px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap">{prompt}</code>
      <Button type="button" size="sm" variant="secondary" onClick={() => navigator.clipboard.writeText(prompt).then(() => setCopied(true))}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
