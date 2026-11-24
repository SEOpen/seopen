"use client";

import { useEffect, useLayoutEffect } from "react";
import { Wordmark } from "@/components/brand/wordmark";
import { Button } from "@/components/ui/button";
import { contactEmail, isHostedService } from "@/lib/instance";
import { withoutRun } from "@/components/ui/retry-button";
import { applySavedTheme } from "@/lib/theme";
import { fontVariables } from "./fonts";
import "./globals.css";

/**
 * A failure in a layout, where error.tsx can't reach. This replaces the root layout, so it brings its
 * own <html> and <body>, and the tokens and fonts the root layout would have supplied. The theme
 * script doesn't run here: before this effect the page follows the system setting (globals.css).
 */
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  useLayoutEffect(applySavedTheme, []);
  useEffect(() => {
    console.error(error);
  }, [error]);
  // An address with ?run=1 would spend again with no price shown, so it reloads without the param.
  const tryAgain = () => {
    const target = withoutRun(window.location.href);
    if (target) window.location.replace(target);
    else retry();
  };
  return (
    <html lang="en" className={`${fontVariables} h-full bg-bg antialiased`} suppressHydrationWarning>
      <body className="min-h-full font-sans text-sm">
        <title>Something went wrong · SEOpen</title>
        <main className="app-type flex min-h-screen flex-col items-center justify-center gap-5 bg-bg px-4 text-center text-fg">
          <Wordmark size={24} />
          <h1 className="font-display text-[24px] leading-8">SEOpen couldn&apos;t load</h1>
          <p className="max-w-md text-pretty text-secondary">
            {isHostedService() && contactEmail() ? (
              <>
                Something went wrong on our side. Try again. If it keeps happening, email{" "}
                <a href={`mailto:${contactEmail()}`} className="text-accent underline-offset-2 hover:underline">
                  {contactEmail()}
                </a>
                .
              </>
            ) : (
              "Something went wrong. Try again. If it keeps happening, the server log has the error."
            )}
          </p>
          <Button type="button" onClick={tryAgain}>
            Try again
          </Button>
        </main>
      </body>
    </html>
  );
}
