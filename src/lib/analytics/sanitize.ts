/**
 * The browser's last check before an event leaves for PostHog (posthog-js `before_send`). The app
 * shows customers' domains, keywords and Search Console data, and posthog-js would otherwise send
 * them in URLs, link text, attributes and referrers. So this keeps only what's listed here and drops
 * everything else, including any property a later posthog-js adds: an unknown event or property
 * never goes out.
 *
 * What survives: which page (path only, no query or hash), which kind of element was clicked (tag
 * names and positions, never text, classes or attributes), the browser and screen, the ids
 * posthog-js needs to stitch a session together, and our own `workspace_id` and `plan`.
 * Imports nothing, so the unit test needs no browser.
 */

type Props = Record<string, unknown>;

/** Mirrors posthog-js's CaptureResult; only these fields are kept. */
export interface PostHogEvent {
  uuid: string;
  event: string;
  properties: Props;
  $set?: Props;
  $set_once?: Props;
  timestamp?: Date;
}

/** The events the app sends. Everything else (rage clicks, heatmaps, exceptions, web vitals…) is dropped. */
const EVENTS = new Set(["$pageview", "$pageleave", "$autocapture", "$identify", "$groupidentify", "$set"]);

/** Full URLs: kept as origin plus a cleaned path. */
const URL_KEYS = new Set(["$current_url", "$session_entry_url", "$initial_current_url"]);
/** Paths: cleaned. */
const PATH_KEYS = new Set(["$pathname", "$prev_pageview_pathname", "$session_entry_pathname", "$initial_pathname"]);

/** Kept as they are: ids, SDK details, the device, and numbers about the page view. */
const PLAIN_KEYS = new Set([
  "token", "distinct_id", "$device_id", "$user_id", "$anon_distinct_id", "$session_id", "$window_id",
  "$pageview_id", "$prev_pageview_id", "$insert_id", "$time", "$duration",
  "$lib", "$lib_version", "$lib_custom_api_host", "$sdk_dist_channel", "$config_defaults", "$configured_session_timeout_ms",
  "$lib_rate_limit_remaining_tokens", "$is_identified", "$process_person_profile", "$internal_or_test_user",
  "$os", "$os_name", "$os_version", "$browser", "$browser_version", "$browser_language", "$browser_language_prefix",
  "$device", "$device_type", "$raw_user_agent", "$timezone", "$timezone_offset",
  "$screen_height", "$screen_width", "$viewport_height", "$viewport_width",
  "$host", "$session_entry_host", "$initial_host",
  "$prev_pageview_duration", "$prev_pageview_last_scroll", "$prev_pageview_last_scroll_percentage",
  "$prev_pageview_max_scroll", "$prev_pageview_max_scroll_percentage", "$prev_pageview_last_content",
  "$prev_pageview_last_content_percentage", "$prev_pageview_max_content", "$prev_pageview_max_content_percentage",
  "$event_type", "$ce_version", "$group_type", "$group_key",
  // Registered by PostHogClient.
  "workspace_id", "plan",
]);

/** Person properties ($set, $set_once): device details and the pages, never referrers or campaign tags. */
const PERSON_KEYS = new Set([
  "$current_url", "$initial_current_url", "$pathname", "$initial_pathname", "$host", "$initial_host",
  "$os", "$os_name", "$os_version", "$browser", "$browser_version", "$device_type", "$raw_user_agent",
  "$screen_height", "$screen_width", "$viewport_height", "$viewport_width", "$internal_or_test_user",
]);

/**
 * A path with every segment that isn't a plain word, number or slug replaced. The app's own paths
 * hold only ids and fixed words (/projects/12, /audit/issues/missing-title), so this changes
 * nothing there; it catches a domain or an encoded keyword typed into the address bar.
 */
export function cleanPath(path: string): string {
  const bare = path.split(/[?#]/)[0];
  return bare
    .split("/")
    .map((s) => (s === "" || /^[A-Za-z0-9_-]+$/.test(s) ? s : ":redacted"))
    .join("/");
}

/** An http(s) URL as origin plus cleaned path, with no query, hash or credentials. Null for anything else. */
export function cleanUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return `${url.origin}${cleanPath(url.pathname)}`;
}

const TAG = /^[a-z][a-z0-9-]*$/;
const position = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : 0);

/** Autocapture's element list, down to tag names and positions. */
function cleanElements(value: unknown): { tag_name: string; nth_child: number; nth_of_type: number }[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((el: Props) => ({
    tag_name: typeof el?.tag_name === "string" && TAG.test(el.tag_name) ? el.tag_name : "unknown",
    nth_child: position(el?.nth_child),
    nth_of_type: position(el?.nth_of_type),
  }));
}

/** PostHog's chain string, rebuilt from the cleaned list rather than trusted. */
function chainOf(elements: { tag_name: string; nth_child: number; nth_of_type: number }[]): string {
  return elements.map((e) => `${e.tag_name}:nth-child="${e.nth_child}"nth-of-type="${e.nth_of_type}"`).join(";");
}

function cleanValue(key: string, value: unknown): unknown {
  if (URL_KEYS.has(key)) return typeof value === "string" ? cleanUrl(value) : null;
  if (PATH_KEYS.has(key)) return typeof value === "string" ? cleanPath(value) : null;
  return value;
}

function cleanPerson(props: unknown): Props | undefined {
  if (!props || typeof props !== "object") return undefined;
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (!PERSON_KEYS.has(k)) continue;
    const clean = cleanValue(k, v);
    if (clean !== null && clean !== undefined) out[k] = clean;
  }
  return out;
}

function cleanProperties(props: Props): Props {
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    if (URL_KEYS.has(k) || PATH_KEYS.has(k) || PLAIN_KEYS.has(k)) {
      const clean = cleanValue(k, v);
      if (clean !== null && clean !== undefined) out[k] = clean;
    }
  }
  const elements = cleanElements(props.$elements);
  if (elements) {
    out.$elements = elements;
    out.$elements_chain = chainOf(elements);
  }
  // The workspace group: its numeric id, and the plan.
  const groups = props.$groups as Props | undefined;
  if (groups && typeof groups.workspace === "string" && /^\d+$/.test(groups.workspace)) out.$groups = { workspace: groups.workspace };
  const groupSet = props.$group_set as Props | undefined;
  if (groupSet && typeof groupSet.plan === "string") out.$group_set = { plan: groupSet.plan };
  const set = cleanPerson(props.$set);
  if (set) out.$set = set;
  const setOnce = cleanPerson(props.$set_once);
  if (setOnce) out.$set_once = setOnce;
  return out;
}

/** posthog-js's `before_send`: the event with only the listed fields, or null to drop it. */
export function sanitizeEvent<T extends PostHogEvent>(event: T | null): T | null {
  if (!event || !EVENTS.has(event.event)) return null;
  const clean = { uuid: event.uuid, event: event.event, properties: cleanProperties(event.properties ?? {}) } as T;
  if (event.timestamp) clean.timestamp = event.timestamp;
  const set = cleanPerson(event.$set);
  if (set) clean.$set = set;
  const setOnce = cleanPerson(event.$set_once);
  if (setOnce) clean.$set_once = setOnce;
  return clean;
}
