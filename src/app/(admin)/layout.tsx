import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminSidebar, AdminSidebarFallback } from "@/components/shell/sidebar";
import { TimeZoneProvider } from "@/components/time-zone";
import { getCurrentUser } from "@/lib/auth/session";
import { currentTimeZone } from "@/lib/workspace/current";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * The admin console's own frame, the app's sidebar with Admin's pages: no project switcher, credits
 * meter or billing banner, since an admin's own workspace has nothing to do with what's here. Each
 * page checks `requireAdmin()` itself (src/lib/admin/access.ts).
 */
export default function AdminLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="app-type flex min-h-screen max-md:flex-col">
      <a
        href="#main"
        className="sr-only rounded-md bg-accent-fill px-3 py-2 text-sm font-medium text-accent-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Skip to content
      </a>
      {/* The sidebar reads the pathname, which a dynamic route only knows at request time. */}
      <Suspense fallback={<AdminSidebarFallback />}>
        <AdminSidebar
          email={
            <Suspense fallback={null}>
              <SignedInAs />
            </Suspense>
          }
        />
      </Suspense>
      <div className="@container/main w-full min-w-0 flex-1 window-column">
        <main id="main" tabIndex={-1} className="page-column w-full py-6 outline-none">
          <TimeZoneProvider timeZone={currentTimeZone()}>{children}</TimeZoneProvider>
        </main>
      </div>
    </div>
  );
}

async function SignedInAs() {
  const user = await getCurrentUser();
  return user ? <p className="truncate px-2.5 py-1.5 text-xs text-muted">{user.email}</p> : null;
}
