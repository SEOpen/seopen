/**
 * The sidebar's width, chosen once and remembered in this browser. SIDEBAR_SCRIPT runs in <head>
 * before first paint and sets `data-sidebar` on <html>, so a collapsed sidebar never flashes open. The
 * `rail:` variant in globals.css reads it. With no choice made it is full from lg and a rail from md
 * to lg. Below md the sidebar is a drawer, which is always full.
 */
export const SIDEBAR_KEY = "seopen_sidebar";
const EVENT = "seopen-sidebar";
const NARROW = "(min-width: 48rem) and (max-width: 63.98rem)";

export const SIDEBAR_SCRIPT = `try{var s=localStorage.getItem("${SIDEBAR_KEY}");if(s==="rail"||s==="full")document.documentElement.dataset.sidebar=s}catch(e){}`;

export function isSidebarRail(): boolean {
  const pref = document.documentElement.dataset.sidebar;
  return pref === "rail" || (pref !== "full" && matchMedia(NARROW).matches);
}

export function setSidebarRail(rail: boolean) {
  const pref = rail ? "rail" : "full";
  document.documentElement.dataset.sidebar = pref;
  try {
    localStorage.setItem(SIDEBAR_KEY, pref);
  } catch {
    // Private windows can refuse storage; the choice still holds until this page is left.
  }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeSidebar(onChange: () => void) {
  const narrow = matchMedia(NARROW);
  window.addEventListener(EVENT, onChange);
  narrow.addEventListener("change", onChange);
  return () => {
    window.removeEventListener(EVENT, onChange);
    narrow.removeEventListener("change", onChange);
  };
}
