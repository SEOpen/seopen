import type { Metadata, Viewport } from "next";
import { SIDEBAR_SCRIPT } from "@/lib/sidebar";
import { THEME_COLOR, THEME_SCRIPT } from "@/lib/theme";
import { fontVariables } from "./fonts";
import "./globals.css";

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: THEME_COLOR.light },
    { media: "(prefers-color-scheme: dark)", color: THEME_COLOR.dark },
  ],
};

export const metadata: Metadata = {
  title: { default: "SEOpen", template: "%s · SEOpen" },
  description: "Rank tracking, site audits, research, Search Console and AI visibility in one app.",
};

// Local app: pages read Postgres on every request, and navigations may wait for it.
export const instant = false;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // The theme script sets data-theme before first paint, so React must not fight over that attribute.
    <html lang="en" className={`${fontVariables} h-full bg-bg antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT + SIDEBAR_SCRIPT }} />
      </head>
      <body className="min-h-full font-sans text-sm">{children}</body>
    </html>
  );
}
