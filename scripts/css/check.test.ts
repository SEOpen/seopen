import { describe, expect, it } from "vitest";
import { staleTokens } from "./check";

const SOURCE = `
:root {
  --bg: #f4f6f8;
  --surface: #ffffff;
  --accent-fill: #a5e86b;
  --scrim: rgba(10, 13, 18, 0.4);
}
:root[data-theme="dark"] {
  --bg: #0a0d12;
  --accent-fill: #a5e86b;
}
@theme inline {
  --color-bg: var(--bg);
}
`;

describe("staleTokens", () => {
  it("passes a minified build with the same values, whatever the hex spelling", () => {
    const built = ":root{--bg:#F4F6F8;--surface:#fff;--accent-fill:#a5e86b}:root[data-theme=dark]{--bg:#0a0d12;--accent-fill:#a5e86b}";
    expect(staleTokens(SOURCE, built)).toEqual([]);
  });

  it("fails the stylesheet that shipped with the old tokens", () => {
    const built = ":root{--bg:#f4f2ec;--surface:#fbfaf7}:root[data-theme=dark]{--bg:#0b0b0a;--surface:#131311}";
    expect(staleTokens(SOURCE, built)).toEqual(["--bg: #f4f6f8", "--surface: #fff", "--accent-fill: #a5e86b", "--bg: #0a0d12"]);
  });

  it("fails when one theme is stale and the other is right", () => {
    const built = ":root{--bg:#f4f6f8;--surface:#fff;--accent-fill:#a5e86b}:root[data-theme=dark]{--bg:#0b0b0a;--accent-fill:#a5e86b}";
    expect(staleTokens(SOURCE, built)).toEqual(["--bg: #0a0d12"]);
  });

  it("ignores tokens that aren't plain hex colours", () => {
    expect(staleTokens(":root{--shadow:0 1px rgba(0,0,0,.2);--color-bg:var(--bg)}", "")).toEqual([]);
  });
});
