"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { INGEST_PATH } from "@/lib/analytics/config";
import { sanitizeSiteEvent } from "@/lib/analytics/site-event";

/**
 * PostHog on the marketing site, in cookieless mode: nothing is stored in the browser (no cookie,
 * no local or session storage), and PostHog's servers tell visits apart with a hash that changes
 * daily. So there's no consent banner. It sends page views and page leaves only, through /ingest on
 * this host (next.config.ts), and `before_send` (src/lib/analytics/site-event.ts) strips queries
 * and trims referrers. Do Not Track turns it off. A named instance, so on one host (local dev,
 * previews) it never shares state with the app's PostHog.
 *
 * Cookieless events are dropped unless the PostHog project has cookieless mode switched on.
 */
export function SitePostHog({ apiKey, uiHost }: { apiKey: string; uiHost: string }) {
  useEffect(() => {
    posthog.init(
      apiKey,
      {
        api_host: INGEST_PATH,
        ui_host: uiHost,
        defaults: "2026-08-30",
        cookieless_mode: "always",
        person_profiles: "identified_only",
        respect_dnt: true,
        autocapture: false,
        capture_pageleave: true,
        disable_capture_url_hashes: true,
        rageclick: false,
        capture_dead_clicks: false,
        capture_heatmaps: false,
        capture_performance: false,
        capture_exceptions: false,
        logs: { captureConsoleLogs: false },
        disable_session_recording: true,
        disable_surveys: true,
        disable_product_tours: true,
        disable_conversations: true,
        disable_web_experiments: true,
        advanced_disable_flags: true,
        disable_external_dependency_loading: true,
        before_send: sanitizeSiteEvent,
      },
      "site",
    );
  }, [apiKey, uiHost]);

  return null;
}
