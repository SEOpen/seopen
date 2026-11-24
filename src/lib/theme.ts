/**
 * The app and the marketing site both follow the system, until the visitor picks Light, Dark or System. The choice is a cookie on the
 * parent domain, so getseopen.com and app.getseopen.com share it. THEME_SCRIPT runs in <head> before
 * first paint and sets `data-theme` (always the resolved theme) and `data-theme-pref` on <html>; it
 * also follows a system change while the choice is System. It points the theme-color tags at the
 * resolved theme too, and again whenever a page change makes Next render them afresh. The server
 * never reads the cookie, so every page stays static.
 */
export const THEME_COOKIE = "seopen_theme";
export type ThemePreference = "system" | "light" | "dark";

/** The browser's own bars. The root layout tags these by system setting for a visitor without script; THEME_SCRIPT moves them to the chosen theme. */
export const THEME_COLOR = { light: "#f2f1ed", dark: "#14171c" };

export const THEME_SCRIPT = `try{(function(){var d=document.documentElement,m=matchMedia("(prefers-color-scheme: dark)"),c=/(?:^|; )${THEME_COOKIE}=(light|dark|system)/.exec(document.cookie);function a(){var p=d.dataset.themePref,t=p==="light"||p==="dark"?p:m.matches?"dark":"light";d.dataset.theme=t;d.querySelectorAll('meta[name="theme-color"]').forEach(function(e){e.media=e.content==="${THEME_COLOR.dark}"===(t==="dark")?"all":"not all"})}d.dataset.themePref=c?c[1]:"system";a();m.addEventListener("change",a);new MutationObserver(a).observe(document.head,{childList:true});window.__seopenTheme=a})()}catch(e){}`;

/** What THEME_SCRIPT does at load, for a document that replaces <html> after it ran (global-error.tsx). */
export function applySavedTheme() {
  const root = document.documentElement;
  const pref = new RegExp(`(?:^|; )${THEME_COOKIE}=(light|dark|system)`).exec(document.cookie)?.[1] ?? "system";
  root.dataset.themePref = pref;
  root.dataset.theme = pref === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : pref;
}

/** Applies a preference now and remembers it for a year. */
export function setThemePreference(pref: ThemePreference) {
  const root = document.documentElement;
  root.dataset.themePref = pref;
  (window as unknown as { __seopenTheme?: () => void }).__seopenTheme?.();
  const host = location.hostname;
  const domain = host === "getseopen.com" || host.endsWith(".getseopen.com") ? "; domain=getseopen.com" : "";
  document.cookie = `${THEME_COOKIE}=${pref}; path=/; max-age=31536000; samesite=lax${domain}${location.protocol === "https:" ? "; secure" : ""}`;
  window.dispatchEvent(new Event("seopen-theme"));
}

export function currentThemePreference(): ThemePreference {
  const pref = document.documentElement.dataset.themePref;
  return pref === "light" || pref === "dark" ? pref : "system";
}
