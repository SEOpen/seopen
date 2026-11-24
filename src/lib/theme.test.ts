import { afterEach, describe, expect, it, vi } from "vitest";
import { applySavedTheme, THEME_COOKIE, THEME_SCRIPT } from "./theme";

function page(cookie: string, systemDark: boolean, url = "https://app.getseopen.com/rank") {
  const dataset: Record<string, string> = {};
  const { hostname, pathname } = new URL(url);
  vi.stubGlobal("document", { cookie, head: {}, documentElement: { dataset, querySelectorAll: () => [] } });
  vi.stubGlobal("location", { hostname, pathname });
  vi.stubGlobal("matchMedia", () => ({ matches: systemDark, addEventListener: () => {} }));
  vi.stubGlobal("MutationObserver", class { observe() {} });
  vi.stubGlobal("window", {});
  return dataset;
}

afterEach(() => vi.unstubAllGlobals());

describe("applySavedTheme", () => {
  it("uses the saved choice over the system setting", () => {
    const dataset = page(`other=1; ${THEME_COOKIE}=light`, true);
    applySavedTheme();
    expect(dataset).toEqual({ themePref: "light", theme: "light" });
  });

  it("follows the system when nothing is saved", () => {
    const dataset = page("other=1", true);
    applySavedTheme();
    expect(dataset).toEqual({ themePref: "system", theme: "dark" });
  });

  it("ignores a cookie that only ends with the name", () => {
    const dataset = page(`not_${THEME_COOKIE}=dark`, false);
    applySavedTheme();
    expect(dataset).toEqual({ themePref: "system", theme: "light" });
  });
});

describe("the site and the app both follow the system", () => {
  // The script is a string in <head>, so it has to be run to know that it agrees with applySavedTheme.
  it.each([
    ["https://getseopen.com/", "", false, { themePref: "system", theme: "light" }],
    ["https://getseopen.com/", "", true, { themePref: "system", theme: "dark" }],
    ["http://127.0.0.1:4100/landing", "", false, { themePref: "system", theme: "light" }],
    ["https://app.getseopen.com/", "", false, { themePref: "system", theme: "light" }],
    ["https://app.getseopen.com/rank", "", true, { themePref: "system", theme: "dark" }],
    ["https://getseopen.com/pricing", `${THEME_COOKIE}=light`, true, { themePref: "light", theme: "light" }],
    ["https://getseopen.com/pricing", `${THEME_COOKIE}=dark`, false, { themePref: "dark", theme: "dark" }],
  ])("THEME_SCRIPT on %s with cookie '%s'", (url, cookie, systemDark, expected) => {
    const dataset = page(cookie, systemDark, url);
    new Function(THEME_SCRIPT)();
    expect(dataset).toEqual(expected);
  });

  it("applySavedTheme agrees with it on the site", () => {
    const dataset = page("", false, "https://getseopen.com/pricing");
    applySavedTheme();
    expect(dataset).toEqual({ themePref: "system", theme: "light" });
  });
});
