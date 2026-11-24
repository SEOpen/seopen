import { appOrigin } from "@/lib/hosts";

/**
 * The address links in emails start with: the copy's own (appOrigin). A copy that emails people on other
 * machines sets BETTER_AUTH_URL, or the hosts, on the worker as well as the web app; without them links
 * point at 127.0.0.1, which works only on the machine itself.
 */
export function emailOrigin(): string {
  return appOrigin();
}
