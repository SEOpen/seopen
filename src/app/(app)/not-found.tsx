import type { Metadata } from "next";
import { MissingPagePanel } from "@/components/shell/missing-page-panel";

// Next adds noindex to every 404 itself, so no robots here (a second tag would duplicate it).
export const metadata: Metadata = { title: "Page not found" };

/** notFound() in the app, such as a keyword that's been removed. Unknown URLs go to the root not-found. */
export default function NotFound() {
  return <MissingPagePanel />;
}
