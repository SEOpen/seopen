import type { Metadata } from "next";
import { Wordmark } from "@/components/brand/wordmark";
import { siteHref, siteLinks } from "@/lib/hosts";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/** Narrow centered column for the sign-in, reset and verification pages. */
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // A self-hosted copy has no marketing site: the logo goes to the app, and there are no site links.
  const site = siteLinks();
  return (
    <main className="app-type flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-sm">
        <a href={site ? siteHref("/") : "/"} className="mx-auto mb-6 block w-fit">
          <Wordmark size={28} />
        </a>
        {children}
        {site && (
          <p className="mt-4 text-center text-muted">
            <a className="underline" href={siteHref("/")}>
              Home
            </a>
            {" · "}
            <a className="underline" href={siteHref("/privacy")}>
              Privacy
            </a>
            {" · "}
            <a className="underline" href={siteHref("/terms")}>
              Terms
            </a>
          </p>
        )}
      </div>
    </main>
  );
}
