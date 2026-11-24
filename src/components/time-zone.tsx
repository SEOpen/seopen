"use client";

import { createContext, use, useContext, type ReactNode } from "react";
import { DEFAULT_TIME_ZONE } from "@/lib/format";

const TimeZoneContext = createContext<Promise<string> | null>(null);

/**
 * Gives client components the workspace's time zone. Takes the promise from `currentTimeZone()`
 * unawaited, so the layout's shell stays static and only a component that reads it waits.
 */
export function TimeZoneProvider({ timeZone, children }: { timeZone: Promise<string>; children: ReactNode }) {
  return <TimeZoneContext.Provider value={timeZone}>{children}</TimeZoneContext.Provider>;
}

/** The workspace's time zone, for formatting dates in a client component. */
export function useTimeZone(): string {
  const timeZone = useContext(TimeZoneContext);
  return timeZone ? use(timeZone) : DEFAULT_TIME_ZONE;
}
