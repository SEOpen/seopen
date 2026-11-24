/** The words in a Sync row. Pure, so it's tested and costs nothing. */
import { formatDay } from "@/lib/format";

export const STATUS_WORDS: Record<string, string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Running",
  ok: "Up to date",
  quota: "Paused by a rate limit",
  error: "Failed",
  reauth: "Reconnect needed",
};

/** The note beside the status badge, left out when it would only repeat the badge. */
export function syncMessage(status: string, message: string | null | undefined): string | null {
  return !message || message === STATUS_WORDS[status] ? null : message;
}

/** How far the sync has asked. It's the last day asked for, so the latest day with data can be earlier: a day with no rows moves this and not that. */
export function syncThrough(day: string): string {
  return `Checked through ${formatDay(day)}`;
}
