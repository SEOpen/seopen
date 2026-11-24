"use client";

import { RotateCw } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { Callout } from "./callout";
import { withoutRun } from "./retry-button";

/**
 * What error.tsx shows when a page fails to load, inside the sidebar. Production hides the real
 * error from the browser, so this never prints it; the server logs carry it.
 */
export function PageFailure({ error, retry, help }: { error: unknown; retry: () => void; help: string }) {
  const [retrying, start] = useTransition();
  const [leaving, setLeaving] = useState(false);
  const pending = retrying || leaving;
  useEffect(() => {
    console.error(error);
  }, [error]);
  // An address with ?run=1 would spend again with no price shown, so it reloads without the param.
  const tryAgain = () => {
    const target = withoutRun(window.location.href);
    if (target) {
      setLeaving(true);
      window.location.replace(target);
    } else start(() => retry());
  };
  return (
    <div className="max-w-2xl">
      <Callout tone="bad" role="alert" title="This page couldn't load">
        <p>Something went wrong while loading it. Try again. {help}</p>
        <Button type="button" size="sm" variant="secondary" className="mt-3" disabled={pending} aria-busy={pending} onClick={tryAgain}>
          <RotateCw aria-hidden className={cn("size-3.5", pending && "animate-spin motion-reduce:animate-none")} strokeWidth={1.5} />
          {pending ? "Retrying" : "Try again"}
        </Button>
      </Callout>
    </div>
  );
}
