import { timeZoneStillUnchosen } from "@/lib/workspace/current";
import { BrowserTimeZoneClient } from "./browser-time-zone-client";

/**
 * Mounted by the `(app)` layout inside a Suspense boundary. Reaches the browser only while the
 * workspace can still take its zone, so once that's settled no page sends anything.
 */
export async function BrowserTimeZone() {
  return (await timeZoneStillUnchosen()) ? <BrowserTimeZoneClient /> : null;
}
