/** The most Admin → Spend accepts, in dollars. */
export const PLATFORM_CAP_MAX = 100_000;
export const OWNER_CAP_MAX = 10_000;

/** A monthly cap as typed: a number from 1 to `max`. Null for anything else, a blank field included. */
export function parseCap(value: FormDataEntryValue | null, max: number): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const cap = Number(value);
  return Number.isFinite(cap) && cap >= 1 && cap <= max ? cap : null;
}

export const capError = (max: number) => `Enter a cap between $1 and $${max.toLocaleString("en-US")}.`;
