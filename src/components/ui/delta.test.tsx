import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Delta, Digits, digitRuns } from "./delta";

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("digitRuns", () => {
  it("cuts text into numbers and words, losing nothing", () => {
    expect(digitRuns("33 keywords · 12,550 searches/mo")).toEqual([
      { text: "33", digits: true },
      { text: " keywords · ", digits: false },
      { text: "12,550", digits: true },
      { text: " searches/mo", digits: false },
    ]);
  });

  it("keeps what's stuck to a number with it", () => {
    const numbers = (s: string) => digitRuns(s).filter((r) => r.digits).map((r) => r.text);
    expect(numbers("12.3%")).toEqual(["12.3%"]);
    expect(numbers("$1,204 / $2,000")).toEqual(["$1,204", "$2,000"]);
    expect(numbers("18.3K searches")).toEqual(["18.3K"]);
    expect(numbers("3, then 4.")).toEqual(["3", "4"]);
  });

  it("has only words when there's no number", () => {
    expect(digitRuns("No limit")).toEqual([{ text: "No limit", digits: false }]);
    expect(digitRuns("")).toEqual([]);
  });
});

describe("Digits", () => {
  it("lets a figure set its own number type", () => {
    const html = renderToStaticMarkup(<Digits text="4 of 88" digitClassName="" />);
    expect(html).not.toContain("data");
    expect(html).toContain("font-sans");
    expect(words(html)).toBe("4 of 88");
  });
});

describe("Delta", () => {
  it("reads as a direction, a size and a word", () => {
    const html = renderToStaticMarkup(<Delta text="+56%" tone="good" />);
    expect(words(html)).toBe("up 56% (better)");
    expect(html).toContain("text-good");
  });

  it("sets its digits and its words in mono, as the mockups do", () => {
    const html = renderToStaticMarkup(<Delta text="2.4 better" tone="good" up />);
    expect(html).toMatch(/^<span class="font-mono /);
    expect(html).toContain("2.4 better");
    const pts = renderToStaticMarkup(<Delta text="+1.4 pts" tone="good" />);
    expect(pts).toMatch(/^<span class="font-mono /);
    expect(pts).toContain("1.4 pts");
  });

  it("draws no direction mark when it says no change", () => {
    const html = renderToStaticMarkup(<Delta text="No change" tone="muted" up={null} />);
    expect(html).not.toContain("<svg");
    expect(words(html)).toBe("No change");
  });
});
