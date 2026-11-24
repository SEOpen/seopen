import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { addDays } from "@/modules/google/windowing";
import { ClicksPanel } from "./clicks-panel";

const history = (perDay: (i: number) => number, n = 28) => ({ days: Array.from({ length: n }, (_, i) => ({ date: addDays("2026-10-27", i - (n - 1)), clicks: perDay(i) })) });

describe("ClicksPanel", () => {
  it("sets the total's digits at the data size and its word in sans", () => {
    const html = renderToStaticMarkup(<ClicksPanel history={history((i) => (i < 25 ? 1 : 0))} />);
    expect(html).toContain('<span class="digits">25</span>');
    expect(html).toContain('<span class="font-sans"> clicks</span>');
  });

  it("gets one click right", () => {
    expect(renderToStaticMarkup(<ClicksPanel history={history((i) => (i === 0 ? 1 : 0))} />)).toContain("> click</span>");
  });
});
