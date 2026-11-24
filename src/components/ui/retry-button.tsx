"use client";

import { RotateCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { cn } from "@/lib/utils";

/** The current address without its run param, or null when it has none. */
export function withoutRun(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has("run")) return null;
  url.searchParams.delete("run");
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Tries a failed page again. Normally that re-renders it on the server, so a failed loader runs
 * again. An address with ?run=1 would spend again with no price shown, so it drops the param
 * instead and the page's Load prompt shows the price first.
 */
export function RetryButton({ className }: { className?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const retry = () => {
    const target = withoutRun(window.location.href);
    start(() => (target ? router.replace(target) : router.refresh()));
  };
  return (
    <button
      type="button"
      onClick={retry}
      disabled={pending}
      aria-busy={pending}
      className={cn(
        "inline-flex min-h-6 shrink-0 items-center gap-1 rounded-sm text-xs font-medium text-accent hover:underline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:no-underline",
        className,
      )}
    >
      <RotateCw aria-hidden className={cn("size-3.5", pending && "animate-spin motion-reduce:animate-none")} />
      {pending ? "Retrying" : "Retry"}
    </button>
  );
}
