const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** 12,345 below 100k, then 123.4K / 1.2M. Null-safe: returns "–". */
export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Math.abs(n) >= 100_000 ? compact.format(n) : whole.format(n);
}

/** $1.23 by default, keeping up to 4 decimals for sub-cent API costs. Pass `digits` for a fixed precision. */
export function formatUsd(n: number | null | undefined, digits?: number): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits ?? 2,
    maximumFractionDigits: digits ?? 4,
  }).format(n);
}

/** 0.1234 → "12.3%". */
export function formatPct(ratio: number | null | undefined, digits = 1): string {
  if (ratio === null || ratio === undefined || Number.isNaN(ratio)) return "–";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** A rate that can sit under 1%, as click rates do: 0.07% and 0.12% would both read 0.1% at one decimal. */
export function formatRate(ratio: number | null | undefined): string {
  return formatPct(ratio, ratio != null && Math.abs(ratio) < 0.01 ? 2 : 1);
}

/**
 * Dates and times. Every instant a person reads renders in the workspace's time zone, passed in
 * from `currentTimeZone()` on the server or `useTimeZone()` in a client component, so an event
 * reads the same wherever it's rendered. Nothing here reads the machine's own zone.
 *
 * A calendar date ("2026-10-29", such as `rank_results.date` or a GSC day) isn't an instant and
 * has no zone: it shows as that day everywhere.
 */
export const DEFAULT_TIME_ZONE = "America/New_York";

/** A stored zone that Intl can use, or the default, so one bad value can't take a page down. */
export function resolveTimeZone(zone: string | null | undefined): string {
  if (!zone) return DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

/**
 * The canonical name of a real IANA zone ("america/new_york" → "America/New_York"), or null. Intl
 * also takes UTC offsets such as "+05:00", which aren't zones and wouldn't follow daylight saving.
 */
export function canonicalTimeZone(zone: string): string | null {
  if (!/^[A-Za-z]/.test(zone)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

const BARE_DAY = /^\d{4}-\d{2}-\d{2}$/;
const isBareDay = (d: Date | string): d is string => typeof d === "string" && BARE_DAY.test(d);

/** A calendar date, "2026-10-29" → "Oct 29, 2026". The same day in every zone. */
export function formatDay(day: string | null | undefined): string {
  if (!day) return "–";
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** An instant's date in `timeZone`: "Nov 2, 2026". A bare calendar date stays that day. */
export function formatDate(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "–";
  if (isBareDay(d)) return formatDay(d);
  return new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone });
}

/** An instant's date without the year, for tight lists: "Nov 2". A bare calendar date stays that day. */
export function formatShortDate(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "–";
  const [date, zone] = isBareDay(d) ? [`${d}T00:00:00Z`, "UTC"] : [d, timeZone];
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone });
}

/** An instant in `timeZone`: "Nov 2, 11:53 PM". A bare calendar date has no time, so it stays that day. */
export function formatDateTime(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "–";
  if (isBareDay(d)) return formatDay(d);
  return new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });
}

/** IANA's names for UTC, lowercased, since Intl takes a zone in any case. */
const UTC_ZONES = new Set(["utc", "etc/utc", "etc/uct", "etc/universal", "etc/zulu", "uct", "universal", "zulu"]);

/**
 * A zone's short name at an instant, to label a time: "ET", "PT", "GMT+9", "UTC". A zone with a
 * short everyday name uses it; any other reads as its offset then, which follows daylight saving.
 * No offset reads "GMT" on every Node: ICU's data calls London's winter "GMT" in Node 24
 * and "GMT+0" in Node 26, and a label mustn't depend on which one rendered it. UTC and its
 * aliases read "UTC" by name for the same reason: Node 23's ICU calls UTC "GMT".
 */
export function timeZoneLabel(timeZone: string, at: Date | string = new Date()): string {
  if (UTC_ZONES.has(timeZone.toLowerCase())) return "UTC";
  const name = (style: "short" | "shortGeneric") =>
    new Intl.DateTimeFormat("en-US", { timeZoneName: style, timeZone }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? "";
  const everyday = name("shortGeneric");
  const label = everyday.length <= 4 ? everyday : name("short");
  return label === "GMT+0" ? "GMT" : label;
}

/** An instant with its zone, for a time someone acts on: "Nov 2, 11:53 PM ET". A bare calendar date stays that day. */
export function formatDateTimeZoned(d: Date | string | null | undefined, timeZone: string): string {
  if (!d) return "–";
  if (isBareDay(d)) return formatDay(d);
  return `${formatDateTime(d, timeZone)} ${timeZoneLabel(timeZone, d)}`;
}

/** A sortable instant in `timeZone`, for chart axes and CSV: "2026-11-02 23:53". */
export function formatTimestamp(d: Date | string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(new Date(d));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}`;
}
