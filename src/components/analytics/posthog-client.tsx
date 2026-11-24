"use client";

import posthog from "posthog-js";
import { useEffect } from "react";
import { INGEST_PATH } from "@/lib/analytics/config";
import { sanitizeEvent } from "@/lib/analytics/sanitize";

type Props = { apiKey: string; uiHost: string; userId: string; workspaceId: number; plan: string };

/**
 * PostHog in the signed-in app (the marketing site has its own cookieless one, site-posthog.tsx). Events go to
 * /ingest on our own host, which next.config.ts rewrites to PostHog. Do Not Track turns it off.
 *
 * The app shows customers' domains, keywords and Google data, so PostHog gets page views and which
 * kind of control was clicked, and nothing from the page: autocapture keeps no text or attributes,
 * every URL loses its query and hash, referrers and campaign tags aren't kept, and `before_send`
 * (src/lib/analytics/sanitize.ts) drops any event or property it doesn't list. Session replay,
 * heatmaps, rage and dead clicks, web vitals, exceptions, console logs, surveys and feature flags
 * are off, and with flags off PostHog's remote config never loads, so none of them can be switched
 * on from PostHog's side. No external PostHog scripts load at all. Nothing is stored in the browser
 * (memory persistence, so no consent banner is needed under EU ePrivacy rules): each page load starts a fresh
 * anonymous id, and identify() ties events to the account id. Ids, the workspace and the plan are the only things we add: never an email or a domain.
 */
export function PostHogClient({ apiKey, uiHost, userId, workspaceId, plan }: Props) {
  useEffect(() => {
    if (!posthog.__loaded) {
      clearLegacyStorage(apiKey);
      posthog.init(apiKey, {
        api_host: INGEST_PATH,
        ui_host: uiHost,
        defaults: "2026-08-30",
        person_profiles: "identified_only",
        respect_dnt: true,
        persistence: "memory",
        mask_all_text: true,
        mask_all_element_attributes: true,
        autocapture: { capture_copied_text: false, capture_value_css_selector_allowlist: [] },
        disable_capture_url_hashes: true,
        save_referrer: false,
        save_campaign_params: false,
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
        before_send: sanitizeEvent,
      });
    }
    // Someone else was signed in on this browser: start a fresh anonymous id before identifying.
    const current = posthog.get_distinct_id();
    if (current !== userId && current !== posthog.get_property("$device_id")) posthog.reset();
    posthog.identify(userId);
    posthog.group("workspace", String(workspaceId), { plan });
    posthog.register({ workspace_id: workspaceId, plan });
  }, [apiKey, uiHost, userId, workspaceId, plan]);

  return null;
}

/**
 * PostHog kept its id in a cookie, then in localStorage and sessionStorage, before persistence moved to memory. Remove the old
 * localStorage entries and expire the old cookies, on this host and on each parent domain PostHog may have set them on.
 */
function clearLegacyStorage(apiKey: string) {
  try {
    for (const store of [localStorage, sessionStorage]) {
      for (const key of Object.keys(store)) if (key.startsWith(`ph_${apiKey}_`)) store.removeItem(key);
    }
  } catch {
    // Storage blocked: nothing to clear.
  }
  const labels = location.hostname.split(".");
  const domains = [""];
  for (let i = 0; i < labels.length - 1; i++) domains.push(`; domain=.${labels.slice(i).join(".")}`);
  for (const name of [`ph_${apiKey}_posthog`, `ph_${apiKey}_posthog_cpm`]) {
    if (!document.cookie.includes(`${name}=`)) continue;
    for (const domain of domains) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain}`;
  }
}
