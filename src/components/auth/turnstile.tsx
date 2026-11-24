"use client";

import Script from "next/script";
import { useEffect, useRef } from "react";
import { TURNSTILE_ACTION } from "@/lib/turnstile";

type TurnstileApi = {
  render(el: HTMLElement, options: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
};

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

/**
 * Cloudflare Turnstile's widget (src/lib/turnstile.ts). Most visitors never see it: it shows only
 * when Cloudflare wants a click. It hands `onToken` a one-use token, or null when the token expires
 * or the check fails. Each new `resetKey` asks for a fresh token, since a submitted one is spent.
 */
export function Turnstile({ siteKey, onToken, resetKey }: { siteKey: string; onToken: (token: string | null) => void; resetKey: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);

  const render = () => {
    if (!box.current || widget.current || !window.turnstile) return;
    widget.current = window.turnstile.render(box.current, {
      sitekey: siteKey,
      action: TURNSTILE_ACTION,
      appearance: "interaction-only",
      theme: "auto",
      callback: (token: string) => onToken(token),
      "expired-callback": () => onToken(null),
      "error-callback": () => onToken(null),
    });
  };

  useEffect(() => {
    if (!resetKey || !widget.current) return;
    onToken(null);
    window.turnstile?.reset(widget.current);
  }, [resetKey, onToken]);

  useEffect(
    () => () => {
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    },
    [],
  );

  return (
    <>
      <Script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" strategy="afterInteractive" onReady={render} />
      <div ref={box} />
    </>
  );
}
