"use client";

import { startTransition, useEffect, useRef } from "react";
import { applyBrowserTimeZone } from "@/app/actions/settings";

/**
 * Sends the browser's zone once, in a transition so the page on screen stays while any refresh
 * loads. A failure stays quiet: the workspace keeps the default, and the next page load tries again.
 */
export function BrowserTimeZoneClient() {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return;
    startTransition(async () => {
      try {
        await applyBrowserTimeZone(zone);
      } catch (err) {
        console.error("[time zone]", err);
      }
    });
  }, []);
  return null;
}
