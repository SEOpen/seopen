import { timeZoneLabel } from "./format";

/**
 * Background jobs run on one clock for every workspace: the worker's cron schedules use this zone
 * (src/worker.ts), and the times in job definitions are wall-clock times here. Copy that states a
 * job's time converts it to the workspace's zone with the helpers below, so "06:00" here reads
 * 11:00 for a London workspace, and follows each zone's daylight saving changes.
 */
export const SCHEDULE_TIME_ZONE = "America/New_York";

/** "HH:mm" on the 24-hour clock, as in a job's cron line. */
export type WallClock = `${number}${number}:${number}${number}`;

const MONDAY = 1;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function wallClockParts(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hourCycle: "h23",
    timeZone,
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour"), minute: part("minute"), second: part("second") };
}

/** The instant `at` falls on the schedule's clock, on the schedule's calendar day `dayOffset` days after `now`'s. */
function scheduledInstant(at: WallClock, now: Date, dayOffset: (weekday: number) => number): Date {
  const { year, month, day } = wallClockParts(now, SCHEDULE_TIME_ZONE);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const [hour, minute] = at.split(":").map(Number);
  const asIfUtc = Date.UTC(year, month - 1, day + dayOffset(weekday), hour, minute);
  // The zone's offset at an instant: how far its clock reads from the same digits in UTC.
  const offsetAt = (instant: number) => {
    const clock = wallClockParts(new Date(instant), SCHEDULE_TIME_ZONE);
    return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second) - instant;
  };
  // Two passes: the offset at the digits read as UTC is the wrong one on a day the clocks change,
  // when the job's time and those digits fall on different sides of the change.
  const guess = asIfUtc - offsetAt(asIfUtc);
  return new Date(asIfUtc - offsetAt(guess));
}

const clockIn = (instant: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(instant);

/** A daily job's time in `timeZone`: `jobTime("06:00", "Europe/London")` → "11:00". */
export function jobTime(at: WallClock, timeZone: string, now = new Date()): string {
  return clockIn(scheduledInstant(at, now, () => 0), timeZone);
}

/** A daily job's time in `timeZone` with the zone, for copy that states it: "06:00 ET". */
export function zonedJobTime(at: WallClock, timeZone: string, now = new Date()): string {
  const instant = scheduledInstant(at, now, () => 0);
  return `${clockIn(instant, timeZone)} ${timeZoneLabel(timeZone, instant)}`;
}

/**
 * A Monday job's time in `timeZone`, with its day, which can differ from Monday: 07:00 on the
 * schedule's clock is already Tuesday in Auckland. Uses the coming Monday, so the conversion is
 * right for the next run across a daylight saving change.
 */
export function mondayJobTime(at: WallClock, timeZone: string, now = new Date()): { day: string; days: string; time: string; zoned: string } {
  const instant = scheduledInstant(at, now, (weekday) => (MONDAY - weekday + 7) % 7);
  const weekday = (style: "short" | "long") => new Intl.DateTimeFormat("en-US", { weekday: style, timeZone }).format(instant);
  const time = clockIn(instant, timeZone);
  return { day: weekday("short"), days: `${weekday("long")}s`, time, zoned: `${time} ${timeZoneLabel(timeZone, instant)}` };
}

/**
 * What each weekly job day reads as in `timeZone`, Sunday first: `value` is the weekday the job
 * goes by (0 = Sunday) and `label` the weekday it lands on there. 06:00 on the schedule's clock is
 * already Monday in Auckland for much of the year, so `value` 0 reads "Monday" there; in most zones
 * every value reads as itself. One offset, from `now`'s run, keeps it one label per value, also in
 * a week when the schedule's clock changes.
 */
export function weeklyJobDays(at: WallClock, timeZone: string, now = new Date()): { value: number; label: string }[] {
  const instant = scheduledInstant(at, now, () => 0);
  const weekdayIn = (zone: string) => {
    const { year, month, day } = wallClockParts(instant, zone);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  };
  const shift = weekdayIn(timeZone) - weekdayIn(SCHEDULE_TIME_ZONE) + 7;
  return WEEKDAYS.map((_, value) => ({ value, weekday: (value + shift) % 7 }))
    .sort((a, b) => a.weekday - b.weekday)
    .map(({ value, weekday }) => ({ value, label: WEEKDAYS[weekday] }));
}
