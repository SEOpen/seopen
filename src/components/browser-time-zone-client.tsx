"use client";

import { useRouter } from "next/navigation";
import { startTransition, useEffect, useRef } from "react";
import { applyBrowserTimeZone } from "@/app/actions/settings";
import { withoutRun } from "@/components/ui/retry-button";

/**
 * Sends the browser's zone once, in a transition so the page on screen stays while any refresh
 * loads. A failure stays quiet: the workspace keeps the default, and the next page load tries again.
 *
 * The action re-renders the address it's sent from, and nobody pressed anything, so a ?run=1 comes off
 * first (as in selectOnThisPage, src/components/shell/project-select.tsx): it would spend with no price
 * shown. The router sends the action only after the replace.
 */
export function BrowserTimeZoneClient() {
  const sent = useRef(false);
  const router = useRouter();
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return;
    startTransition(async () => {
      try {
        const target = withoutRun(window.location.href);
        if (target) router.replace(target);
        await applyBrowserTimeZone(zone);
      } catch (err) {
        console.error("[time zone]", err);
      }
    });
  }, [router]);
  return null;
}
