import type { Metadata } from "next";
import { Suspense } from "react";
import { PostHogAnalytics } from "@/components/analytics/posthog-analytics";
import { BrowserTimeZone } from "@/components/browser-time-zone";
import { LockedNotice } from "@/components/shell/locked-notice";
import { AppSidebar, AppSidebarFallback } from "@/components/shell/sidebar";
import { TimeZoneProvider } from "@/components/time-zone";
import { loadShell } from "@/lib/shell";
import { currentTimeZone } from "@/lib/workspace/current";
import { shell as plan } from "@/plan-policy/shell";

/** The app is private; only the marketing pages belong in search results. */
export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The sidebar and the page. Nothing here waits: the sidebar and the page each take what they read as a
 * promise, so the static shell shows at once. Breakpoints inside the page measure `main`, not the
 * window, because the sidebar's width isn't the page's to know.
 */
export default function AppLayout({ children }: LayoutProps<"/">) {
  const shell = loadShell();
  return (
    <div className="app-type flex min-h-screen max-md:flex-col">
      <a
        href="#main"
        className="sr-only rounded-md bg-accent-fill px-3 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      <Suspense fallback={<AppSidebarFallback />}>
        <AppSidebar
          shell={shell}
          meter={
            <Suspense fallback={<div className="h-8" />}>
              <plan.Meter />
            </Suspense>
          }
        />
      </Suspense>
      <div className="@container/main w-full min-w-0 flex-1 window-column">
        <main id="main" tabIndex={-1} className="page-column w-full py-6 outline-none">
          <Suspense fallback={null}>
            <plan.Banner />
          </Suspense>
          <Suspense fallback={null}>
            <LockedNotice shell={shell} />
          </Suspense>
          <TimeZoneProvider timeZone={currentTimeZone()}>{children}</TimeZoneProvider>
        </main>
      </div>
      <Suspense fallback={null}>
        <PostHogAnalytics />
      </Suspense>
      <Suspense fallback={null}>
        <BrowserTimeZone />
      </Suspense>
    </div>
  );
}
