import { describe, expect, it } from "vitest";
import { briefSentence, countDelta, countMove, countOf, rateDelta, type Move } from "./brief";

const good = (clause: string, weight = 0.5): Move => ({ clause, tone: "good", weight });
const bad = (clause: string, weight = 0.5): Move => ({ clause, tone: "bad", weight });

describe("briefSentence with a neutral move", () => {
  const move = (clause: string, tone: Move["tone"], weight = 0.5): Move => ({ clause, tone, weight });

  it("joins it with and: it's no counterpoint to either side", () => {
    expect(briefSentence([move("one", "bad", 0.3), move("two", "neutral")], "x")).toBe("One, and two.");
    expect(briefSentence([move("one", "good"), move("two", "neutral", 0.3)], "x")).toBe("One, and two.");
  });

  it("still leads with the worst, and keeps a bad and a good together", () => {
    expect(briefSentence([move("flat", "neutral", 0.9), move("fell", "bad", 0.2)], "x")).toBe("Fell, and flat.");
    expect(briefSentence([move("flat", "neutral", 0.9), move("rose", "good", 0.2)], "x")).toBe("Rose, and flat.");
    expect(briefSentence([move("flat", "neutral", 0.9), move("rose", "good", 0.2), move("fell", "bad", 0.2)], "x")).toBe("Fell, but rose.");
  });

  it("is said alone when it's all there is", () => {
    expect(briefSentence([move("flat", "neutral")], "x")).toBe("Flat.");
  });
});

describe("briefSentence", () => {
  it("is calm when nothing moved enough", () => {
    expect(briefSentence([], "Nothing moved.")).toBe("Nothing moved.");
    expect(briefSentence([good("clicks are up 2%", 0.02)], "Nothing moved.")).toBe("Nothing moved.");
  });

  it("says one move as a sentence", () => {
    expect(briefSentence([good("clicks are up 12% on the 28 days before")], "x")).toBe("Clicks are up 12% on the 28 days before.");
  });

  it("puts the worst first, and never hides a fall behind a bigger rise", () => {
    expect(briefSentence([good("clicks are up 80%", 0.8), good("sessions are up 40%", 0.4), bad("site health fell 3 points", 0.3)], "x")).toBe("Site health fell 3 points, but clicks are up 80%.");
  });

  it("joins two of the same kind with and", () => {
    expect(briefSentence([bad("a fell", 0.9), bad("b fell", 0.4), bad("c fell", 0.3)], "x")).toBe("A fell, and b fell.");
  });
});

describe("countDelta", () => {
  it("uses a percentage on a real count", () => {
    expect(countDelta(120, 100)).toMatchObject({ text: "+20%", tone: "good", up: true });
  });

  it("uses the plain difference when both sides are small", () => {
    expect(countDelta(3, 5)).toMatchObject({ text: "−2", tone: "bad", up: false });
    expect(countDelta(37, 14)).toMatchObject({ text: "+23", tone: "good", up: true });
  });

  it("uses the plain difference when either side is small, so a percentage can't overstate it", () => {
    expect(countDelta(38, 61)).toMatchObject({ text: "−23", tone: "bad", up: false });
    expect(countDelta(0, 100)).toMatchObject({ text: "−100", tone: "bad", up: false });
    expect(countDelta(150, 100)).toMatchObject({ text: "+50%" });
  });

  it("words percentages whole from 10%, with one decimal below", () => {
    expect(countDelta(156, 100)).toMatchObject({ text: "+56%" });
    expect(countDelta(1054, 1000)).toMatchObject({ text: "+5.4%" });
  });

  it("says a small count's first reading, but not a large one's", () => {
    expect(countDelta(30, 0)).toMatchObject({ text: "+30" });
    expect(countDelta(500, 0)).toBeNull();
  });

  it("has nothing to say with nothing earlier", () => {
    expect(countDelta(3, null)).toBeNull();
    expect(countDelta(50, 0)).toBeNull();
  });

  it("reads a count that should fall the other way round", () => {
    expect(countDelta(3, 5, "down")).toMatchObject({ tone: "good", up: false });
  });
});

describe("countMove", () => {
  it("rounds the percentage and says what it compares", () => {
    expect(countMove("clicks", 112, 100, "on the 28 days before")).toMatchObject({ clause: "clicks are up 12% on the 28 days before", tone: "good" });
  });

  it("says the same size as the figure beside it", () => {
    const clause = (now: number, before: number) => countMove("clicks", now, before, "")!.clause.trim();
    expect(clause(37, 14)).toBe("clicks are up 23");
    expect(clause(38, 61)).toBe("clicks are down 23");
    expect(clause(1054, 1000)).toBe("clicks are up 5.4%");
    expect(countDelta(37, 14)?.text).toBe("+23");
    expect(countDelta(1054, 1000)?.text).toBe("+5.4%");
  });

  it("keeps money as a percentage, so it needn't name a currency", () => {
    expect(countMove("revenue", 37, 14, "", "up", true)?.clause.trim()).toBe("revenue are up 164%");
  });

  it("doesn't make news of small counts", () => {
    expect(countMove("clicks", 12, 18, "x")).toBeNull();
    expect(countMove("clicks", 100, 100, "x")).toBeNull();
    expect(countMove("clicks", 100, null, "x")).toBeNull();
  });
});

describe("countOf", () => {
  it("spells small counts and pluralizes", () => {
    expect(countOf(1, "keyword")).toBe("one keyword");
    expect(countOf(2, "keyword")).toBe("two keywords");
    expect(countOf(12, "keyword")).toBe("12 keywords");
  });
});

describe("rateDelta", () => {
  it("keeps a move under a point that one decimal would round away", () => {
    expect(rateDelta(0.0012, 0.0007)).toEqual({ text: "+0.05 pts", tone: "good", up: true });
    expect(rateDelta(0.0007, 0.0012)).toEqual({ text: "−0.05 pts", tone: "bad", up: false });
  });

  it("uses plain points from one point up", () => {
    expect(rateDelta(0.05, 0.03)).toEqual({ text: "+2 pts", tone: "good", up: true });
  });

  it("says one point in the singular, on both sides of the small-move cut-off", () => {
    expect(rateDelta(0.04, 0.03)).toEqual({ text: "+1 pt", tone: "good", up: true });
    expect(rateDelta(0.03998, 0.03)).toEqual({ text: "+1 pt", tone: "good", up: true });
  });

  it("calls a change too small to show no change", () => {
    expect(rateDelta(0.05, 0.05)).toEqual({ text: "No change", tone: "muted", up: null });
    expect(rateDelta(0.05001, 0.05)).toEqual({ text: "No change", tone: "muted", up: null });
  });
});
