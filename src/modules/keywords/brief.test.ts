import { describe, expect, it } from "vitest";
import { countryName, ideasFigures, ideasSentence, listFigures, listSentence, listsFigures, listsSentence, lookupFigures, lookupSentence, type LookupBrief } from "./brief";

const NOW = new Date("2026-11-04T12:00:00Z");
const DAYS_AGO = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

const lookup = (over: Partial<LookupBrief> = {}): LookupBrief => ({
  keyword: "roof repair",
  place: "the United States",
  volume: 1900,
  yearly: null,
  kd: 24,
  cpc: 4.5,
  competition: 0.45,
  competitionLevel: "LOW",
  ...over,
});

describe("countryName", () => {
  it("adds the article only where a country takes one", () => {
    expect(countryName("United States")).toBe("the United States");
    expect(countryName("Netherlands")).toBe("the Netherlands");
    expect(countryName("Germany")).toBe("Germany");
  });
});

describe("lookupSentence", () => {
  it("says a move up and a move down over the year", () => {
    expect(lookupSentence(lookup({ yearly: 25 }))).toBe("“roof repair” gets about 1,900 searches a month in the United States. Searches are up 25% on a year ago.");
    expect(lookupSentence(lookup({ yearly: -20 }))).toBe("“roof repair” gets about 1,900 searches a month in the United States. Searches are down 20% on a year ago.");
  });

  it("calls a small move no move", () => {
    expect(lookupSentence(lookup({ yearly: 0 }))).toBe("“roof repair” gets about 1,900 searches a month in the United States. That's about the same as a year ago.");
    expect(lookupSentence(lookup({ yearly: 5 }))).toContain("about the same as a year ago");
  });

  it("says when there's nothing earlier to compare", () => {
    expect(lookupSentence(lookup({ yearly: null }))).toBe("“roof repair” gets about 1,900 searches a month in the United States. There's no year-ago number to compare with.");
  });

  it("gives small counts as a plain difference", () => {
    expect(lookupSentence(lookup({ volume: 10, yearly: 100 }))).toBe("“roof repair” gets about 10 searches a month in the United States. That's up 5 on a year ago.");
    expect(lookupSentence(lookup({ volume: 6, yearly: -50 }))).toContain("That's down 6 on a year ago.");
    expect(lookupSentence(lookup({ volume: 10, yearly: 0 }))).toContain("That's the same as a year ago.");
  });

  it("has nothing to say about a keyword with no volume", () => {
    expect(lookupSentence(lookup({ volume: null, yearly: 10 }))).toBe("“roof repair” has no search volume on record in the United States.");
    expect(lookupSentence(lookup({ volume: 0 }))).toBe("“roof repair” has no search volume on record in the United States.");
  });

  it("leads with the city when it has a number, and says which number moved", () => {
    const city = { name: "Salem", volume: 90, reportable: true };
    expect(lookupSentence(lookup({ city, yearly: 25 }))).toBe("“roof repair” gets about 90 searches a month in Salem and 1,900 across the United States. Searches across the United States are up 25% on a year ago.");
  });

  it("stays on the country when the city has no number", () => {
    const city = { name: "Salem", volume: null, reportable: true };
    expect(lookupSentence(lookup({ city }))).toContain("a month in the United States.");
  });
});

describe("a yearly change that's about the latest month, not the average", () => {
  const latest = { month: "2026-09", volume: 170 };
  const falling = (over: Partial<LookupBrief> = {}) => lookup({ keyword: "web design salem", volume: 720, yearly: -93, latest, ...over });

  it("says the 12-month average and the month the change is about", () => {
    expect(lookupSentence(falling())).toBe("“web design salem” gets about 720 searches a month in the United States, averaged over 12 months. Sep 2026 had 170, down 93% on a year earlier.");
  });

  it("names the place when a city leads", () => {
    expect(lookupSentence(falling({ city: { name: "Salem", volume: 90, reportable: true } }))).toBe(
      "“web design salem” gets about 90 searches a month in Salem and 720 across the United States, averaged over 12 months. Sep 2026 had 170 across the United States, down 93% on a year earlier.",
    );
  });

  it("keeps small counts plain and calm moves calm", () => {
    expect(lookupSentence(falling({ volume: 12, yearly: 100, latest: { month: "2026-09", volume: 10 } }))).toContain("Sep 2026 had 10, up 5 on a year earlier.");
    expect(lookupSentence(falling({ yearly: 0 }))).toContain("Sep 2026 had 170, about the same as a year earlier.");
    expect(lookupSentence(falling({ yearly: null }))).toContain("averaged over 12 months. Sep 2026 had 170.");
  });

  it("doesn't set the change beside the average as if the average had moved", () => {
    expect(lookupFigures(falling())[0]).toMatchObject({
      value: "720",
      delta: { tone: "bad", text: "−93%" },
      caption: "a month in the United States, averaged over 12 months. The change is Sep 2026 (170) vs a year earlier",
    });
    expect(lookupFigures(falling({ yearly: null }))[0]).toMatchObject({ delta: null, caption: "a month in the United States, averaged over 12 months. Sep 2026 had 170" });
  });
});

describe("lookupFigures", () => {
  it("shows a year's move up or down, in percent", () => {
    expect(lookupFigures(lookup({ yearly: 25 }))[0]).toMatchObject({ value: "1,900", delta: { tone: "good", text: "+25%" }, caption: "a month in the United States, vs a year ago" });
    expect(lookupFigures(lookup({ yearly: -20 }))[0]).toMatchObject({ delta: { tone: "bad", text: "−20%" } });
  });

  it("shows a small count's move as a plain difference", () => {
    expect(lookupFigures(lookup({ volume: 10, yearly: 100 }))[0]).toMatchObject({ value: "10", delta: { tone: "good", text: "+5" } });
  });

  it("has no change on a first reading", () => {
    expect(lookupFigures(lookup({ yearly: null }))[0]).toMatchObject({ delta: null, caption: "a month in the United States" });
  });

  it("doesn't divide by nothing when volume fell to zero", () => {
    expect(lookupFigures(lookup({ volume: 0, yearly: -100 }))[0]).toMatchObject({ value: "0", delta: null });
  });

  it("puts the difficulty word in the caption and leaves the number uncoloured", () => {
    expect(lookupFigures(lookup())[1]).toMatchObject({ label: "Keyword difficulty", value: "24", caption: "Easy. 0 to 100, lower is easier" });
  });

  it("explains a missing number in its place", () => {
    const [volume, kd, cpc] = lookupFigures(lookup({ volume: null, kd: null, cpc: null }));
    expect(volume).toMatchObject({ state: "empty", text: "No search volume on record in the United States." });
    expect(kd).toMatchObject({ state: "empty" });
    expect(cpc).toMatchObject({ state: "empty" });
  });

  it("carries the city in the volume's caption", () => {
    expect(lookupFigures(lookup({ city: { name: "Salem", volume: 90, reportable: true } }))[0]).toMatchObject({ caption: "a month in the United States, 90 in Salem" });
    expect(lookupFigures(lookup({ city: { name: "Salem", volume: null, reportable: true } }))[0]).toMatchObject({ caption: "a month in the United States, too few in Salem for Google to report a number" });
    expect(lookupFigures(lookup({ city: { name: "Salem", volume: null, reportable: false } }))[0]).toMatchObject({ caption: "a month in the United States, Google Ads can't report on this phrase for Salem" });
  });

  it("adds the project's place only when it's known", () => {
    expect(lookupFigures(lookup())).toHaveLength(3);
    expect(lookupFigures(lookup({ own: { domain: "example.com", position: 3 } }))[3]).toMatchObject({ label: "Top 10 position", value: "#3" });
    expect(lookupFigures(lookup({ own: { domain: "example.com", position: null } }))[3]).toMatchObject({ state: "empty", text: "example.com isn't in the top 10." });
  });
});

describe("ideasSentence", () => {
  const row = (kd: number | null, volume: number | null = 100, keyword = "x") => ({ keyword, kd, volume });

  it("counts the ideas and the easy ones", () => {
    expect(ideasSentence({ seed: "roof", kind: "questions", rows: [row(10), row(20), row(70)] })).toBe("Three questions for “roof”, two of them easy to rank for.");
    expect(ideasSentence({ seed: "roof", kind: "related", rows: [row(10), row(70)] })).toBe("Two related searches for “roof”, one of them easy to rank for.");
  });

  it("says all and none plainly", () => {
    expect(ideasSentence({ seed: "roof", kind: "suggestions", rows: [row(10), row(20)] })).toBe("Two suggestions for “roof”, all of them easy to rank for.");
    expect(ideasSentence({ seed: "roof", kind: "suggestions", rows: [row(50), row(90)] })).toBe("Two suggestions for “roof”, none of them easy to rank for.");
  });

  it("gets a single idea right", () => {
    expect(ideasSentence({ seed: "roof", kind: "questions", rows: [row(10)] })).toBe("One question for “roof”, and it's easy to rank for.");
    expect(ideasSentence({ seed: "roof", kind: "questions", rows: [row(60)] })).toBe("One question for “roof”, and it's not easy to rank for.");
  });

  it("leaves difficulty out when nothing has a score", () => {
    expect(ideasSentence({ seed: "roof", kind: "questions", rows: [row(null), row(null)] })).toBe("Two questions for “roof”.");
  });
});

describe("ideasFigures", () => {
  it("adds up, and names the biggest", () => {
    const [ideas, volume, easy, top] = ideasFigures({ rows: [{ keyword: "a", volume: 100, kd: 10 }, { keyword: "b", volume: 300, kd: 60 }, { keyword: "c", volume: null, kd: null }], total: 900 });
    expect(ideas).toMatchObject({ value: "3", caption: "the top 3 of 900 by volume" });
    expect(volume).toMatchObject({ value: "400" });
    expect(easy).toMatchObject({ value: "1", caption: "difficulty under 30" });
    expect(top).toMatchObject({ value: "300", caption: "b" });
  });

  it("explains missing numbers instead of showing zero", () => {
    const [, volume, easy, top] = ideasFigures({ rows: [{ keyword: "a", volume: null, kd: null }], total: 1 });
    expect(volume).toMatchObject({ state: "empty" });
    expect(easy).toMatchObject({ state: "empty" });
    expect(top).toMatchObject({ state: "empty" });
  });
});

describe("listsSentence", () => {
  const list = (daysAgo: number, keywords = 5) => ({ name: "A", keywords, volume: 100, updatedAt: DAYS_AGO(daysAgo) });

  it("says what changed in the last week", () => {
    expect(listsSentence([list(1), list(2), list(30)], NOW)).toBe("Two lists changed in the last 7 days. 15 keywords saved across three lists.");
  });

  it("is calm when nothing did", () => {
    expect(listsSentence([list(30, 1)], NOW)).toBe("Nothing changed in the last 7 days. One keyword saved across one list.");
  });

  it("handles no lists", () => {
    expect(listsSentence([], NOW)).toBe("No saved lists yet.");
  });

  it("adds up the figures and names the latest list", () => {
    const [lists, keywords, volume, updated] = listsFigures([{ ...list(30), name: "Old" }, { ...list(1), name: "New" }], "UTC");
    expect(lists).toMatchObject({ value: "2" });
    expect(keywords).toMatchObject({ value: "10" });
    expect(volume).toMatchObject({ value: "200" });
    expect(updated).toMatchObject({ value: "Nov 3", caption: "New" });
  });
});

describe("listSentence", () => {
  const item = (daysAgo: number, keyword = "roof", kd: number | null = 20, volume: number | null = 100) => ({ keyword, kd, volume, createdAt: DAYS_AGO(daysAgo) });

  it("says what was added", () => {
    expect(listSentence([item(1), item(30), item(40)], NOW)).toBe("One keyword added in the last 7 days. The list holds three keywords.");
  });

  it("says when the whole list is new", () => {
    expect(listSentence([item(1), item(2)], NOW)).toBe("Two keywords added in the last 7 days, the whole list so far.");
  });

  it("is calm when nothing was added", () => {
    expect(listSentence([item(30)], NOW)).toBe("Nothing added in the last 7 days. The list holds one keyword.");
  });

  it("handles an empty list", () => {
    expect(listSentence([], NOW)).toBe("This list is empty.");
  });

  it("shows additions as a plain count, and only additions", () => {
    const [recent] = listFigures([item(1), item(30)], NOW, "UTC");
    expect(recent).toMatchObject({ value: "2", delta: { text: "+1", tone: "good" }, caption: "added in the last 7 days" });
    const [calm] = listFigures([item(30)], NOW, "UTC");
    expect(calm).toMatchObject({ value: "1", delta: null, caption: "last added Oct 5, 2026" });
  });

  it("averages only the keywords with a score, and counts questions", () => {
    const [, volume, kd, questions] = listFigures([item(1, "how to fix a roof", 20), item(1, "roof", 40), item(1, "roofer", null, null)], NOW, "UTC");
    expect(volume).toMatchObject({ value: "200" });
    expect(kd).toMatchObject({ value: "30", caption: "Possible. 0 to 100, lower is easier" });
    expect(questions).toMatchObject({ value: "1" });
  });

  it("says why there's no average", () => {
    expect(listFigures([item(1, "roof", null)], NOW, "UTC")[2]).toMatchObject({ state: "empty" });
  });
});
