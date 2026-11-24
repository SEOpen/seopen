import { describe, expect, it } from "vitest";
import { cleanPath, cleanUrl, sanitizeEvent, type PostHogEvent } from "./sanitize";

// Shaped like the events posthog-js 1.444 sent from the app before the sanitizer (captured locally).
const autocapture: PostHogEvent = {
  uuid: "u1",
  event: "$autocapture",
  timestamp: new Date("2026-11-07T21:00:00Z"),
  properties: {
    token: "phc_test",
    distinct_id: "user-1",
    $session_id: "s1",
    $current_url: "https://app.getseopen.com/gsc/queries?sort=clicks#betaweb.example",
    $host: "app.getseopen.com",
    $pathname: "/gsc/queries",
    $referrer: "https://www.google.com/search?q=salem+web+design",
    $referring_domain: "www.google.com",
    $session_entry_url: "https://app.getseopen.com/gsc/page?url=https%3A%2F%2Fbetaweb.example%2F",
    $session_entry_referrer: "https://betaweb.example/blog/",
    utm_term: "salem web design",
    ph_keyword: "salem web design",
    title: "betaweb.example · Search Console · SEOpen",
    $event_type: "click",
    $ce_version: 1,
    $el_text: "north salem web design",
    $external_click_url: "https://betaweb.example/about/",
    $element_selectors: ["a.keyword"],
    $elements: [
      {
        tag_name: "a",
        $el_text: "north salem web design",
        classes: ["text-accent"],
        attr__href: "/gsc/query?q=north%20salem%20web%20design",
        attr__class: "text-accent",
        nth_child: 1,
        nth_of_type: 1,
      },
      { tag_name: "td", nth_child: 1, nth_of_type: 1 },
      { tag_name: 'tr"><script', nth_child: "2", nth_of_type: 2 },
    ],
    $elements_chain: 'a:attr__href="/gsc/query?q=north%20salem%20web%20design"nth-child="1"nth-of-type="1"text="north salem web design"',
    $groups: { workspace: "7", other: "betaweb.example" },
    workspace_id: 7,
    plan: "pro",
    some_future_property: "betaweb.example",
  },
  $set_once: {
    $initial_current_url: "https://app.getseopen.com/domains?q=betaweb.example",
    $initial_referrer: "https://betaweb.example/",
    $initial_utm_term: "salem web design",
    $initial_pathname: "/domains",
  },
};

/** Every string anywhere in a value, for "nothing leaked" checks. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

describe("sanitizeEvent", () => {
  const out = sanitizeEvent(structuredClone(autocapture))!;

  it("leaves no domain, keyword, query or hash anywhere in the event", () => {
    for (const s of strings(out)) {
      expect(s).not.toMatch(/betaweb|salem|web design|google/i);
      expect(s).not.toMatch(/[?#]/);
    }
  });

  it("keeps the page without its query or hash", () => {
    expect(out.properties.$current_url).toBe("https://app.getseopen.com/gsc/queries");
    expect(out.properties.$session_entry_url).toBe("https://app.getseopen.com/gsc/page");
    expect(out.$set_once).toEqual({ $initial_current_url: "https://app.getseopen.com/domains", $initial_pathname: "/domains" });
  });

  it("reduces elements to tag names and positions, and rebuilds the chain from them", () => {
    expect(out.properties.$elements).toEqual([
      { tag_name: "a", nth_child: 1, nth_of_type: 1 },
      { tag_name: "td", nth_child: 1, nth_of_type: 1 },
      { tag_name: "unknown", nth_child: 0, nth_of_type: 2 },
    ]);
    expect(out.properties.$elements_chain).toBe('a:nth-child="1"nth-of-type="1";td:nth-child="1"nth-of-type="1";unknown:nth-child="0"nth-of-type="2"');
  });

  it("drops a chain it can't rebuild from a cleaned element list", () => {
    const properties = { ...autocapture.properties };
    delete properties.$elements;
    expect(sanitizeEvent({ ...autocapture, properties })!.properties).not.toHaveProperty("$elements_chain");
  });

  it("keeps the ids, the workspace group and our own properties", () => {
    expect(out.properties).toMatchObject({ token: "phc_test", distinct_id: "user-1", $session_id: "s1", $event_type: "click", workspace_id: 7, plan: "pro" });
    expect(out.properties.$groups).toEqual({ workspace: "7" });
    expect(out.uuid).toBe("u1");
    expect(out.timestamp).toEqual(autocapture.timestamp);
  });

  it("drops text, referrers, campaign tags, titles and properties it doesn't know", () => {
    for (const key of ["$el_text", "$external_click_url", "$element_selectors", "$referrer", "$referring_domain", "$session_entry_referrer", "utm_term", "ph_keyword", "title", "some_future_property"]) {
      expect(out.properties).not.toHaveProperty(key);
    }
  });

  it("keeps only the plan in the workspace group's properties", () => {
    const group = sanitizeEvent({ uuid: "g", event: "$groupidentify", properties: { token: "t", $group_type: "workspace", $group_key: "7", $group_set: { plan: "pro", name: "betaweb.example" } } })!;
    expect(group.properties).toEqual({ token: "t", $group_type: "workspace", $group_key: "7", $group_set: { plan: "pro" } });
  });

  it("drops events the app doesn't send on purpose", () => {
    for (const event of ["$rageclick", "$dead_click", "$$heatmap", "$exception", "$web_vitals", "$copy_autocapture", "survey sent", "anything_new"]) {
      expect(sanitizeEvent({ uuid: "x", event, properties: { token: "t" } })).toBeNull();
    }
    expect(sanitizeEvent(null)).toBeNull();
  });
});

describe("cleanPath and cleanUrl", () => {
  it("keeps the app's own paths as they are", () => {
    for (const p of ["/", "/projects/12/settings", "/audit/issues/missing-title", "/rank/345", "/gsc/countries-devices"]) expect(cleanPath(p)).toBe(p);
  });

  it("redacts a segment that holds a domain or an encoded keyword", () => {
    expect(cleanPath("/domains/betaweb.example")).toBe("/domains/:redacted");
    expect(cleanPath("/keywords/best%20crm/x")).toBe("/keywords/:redacted/x");
    expect(cleanPath("/gsc/page?url=https://betaweb.example/#top")).toBe("/gsc/page");
  });

  it("returns origin and path, and nothing for other schemes or junk", () => {
    expect(cleanUrl("https://user:pw@app.getseopen.com/domains?q=betaweb.example#x")).toBe("https://app.getseopen.com/domains");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("not a url")).toBeNull();
  });
});
