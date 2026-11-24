import type { Metadata } from "next";
import { Wordmark } from "@/components/brand/wordmark";
import { appHref, siteHref } from "@/lib/hosts";

// Next adds noindex to every 404 itself, so no robots here (a second tag would duplicate it).
export const metadata: Metadata = { title: "Page not found" };

/**
 * Unknown URLs on either host, and notFound() on the marketing site and in admin; the app's own pages
 * have `(app)/not-found.tsx`. Neutral on purpose, since it renders outside both layouts: a real 404
 * status, a way back to the site and to the app.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-bg px-4 text-center text-fg">
      <a href={siteHref("/")} aria-label="SEOpen home">
        <Wordmark size={24} />
      </a>
      <h1 className="font-display text-4xl">Page not found</h1>
      <p className="max-w-md text-base text-pretty text-muted">The page you asked for isn&apos;t here. It may have moved, or the link may be wrong.</p>
      <div className="flex gap-6 text-base">
        <a href={siteHref("/")} className="underline underline-offset-4 hover:text-muted">
          SEOpen home
        </a>
        <a href={appHref("/")} className="underline underline-offset-4 hover:text-muted">
          Open the app
        </a>
      </div>
    </main>
  );
}
