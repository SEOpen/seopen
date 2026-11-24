import { describe, expect, it } from "vitest";
import type { PostHogEvent } from "./sanitize";
import { sanitizeSiteEvent } from "./site-event";

const event = (name: string, properties: Record<string, unknown>, extra: Partial<PostHogEvent> = {}): PostHogEvent => ({ uuid: "u1", event: name, properties, ...extra });

describe("sanitizeSiteEvent", () => {
  it("keeps page views and page leaves, and drops everything else", () => {
    expect(sanitizeSiteEvent(event("$pageview", {}))?.event).toBe("$pageview");
    expect(sanitizeSiteEvent(event("$pageleave", {}))?.event).toBe("$pageleave");
    for (const name of ["$autocapture", "$identify", "$web_vitals", "$exception", "waitlist_joined"]) expect(sanitizeSiteEvent(event(name, {}))).toBeNull();
    expect(sanitizeSiteEvent(null)).toBeNull();
  });

  it("strips queries and hashes from page addresses and trims referrers to their origin", () => {
    const out = sanitizeSiteEvent(
      event("$pageview", {
        $current_url: "https://getseopen.com/pricing?email=a@b.com#plans",
        $session_entry_url: "https://getseopen.com/?utm_source=x",
        $referrer: "https://www.google.com/search?q=seopen",
        $initial_referrer: "$direct",
        $session_entry_referrer: "javascript:alert(1)",
        utm_source: "x",
        $pathname: "/pricing",
      }),
    );
    expect(out?.properties).toEqual({
      $current_url: "https://getseopen.com/pricing",
      $session_entry_url: "https://getseopen.com/",
      $referrer: "https://www.google.com",
      $initial_referrer: "$direct",
      $session_entry_referrer: null,
      // Campaign tags and the path are what the channel and the landing page come from.
      utm_source: "x",
      $pathname: "/pricing",
    });
  });

  it("sets nothing on a person", () => {
    const out = sanitizeSiteEvent(event("$pageview", {}, { $set: { $current_url: "x" }, $set_once: { $initial_referrer: "y" } }));
    expect(out).not.toHaveProperty("$set");
    expect(out).not.toHaveProperty("$set_once");
  });
});
