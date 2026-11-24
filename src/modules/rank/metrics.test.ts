import { describe, expect, it } from "vitest";
import {
  averagePosition,
  bucketOf,
  classifyChange,
  ctr,
  CTR_TOP20_TOTAL,
  estimateCheckCost,
  estimatedTraffic,
  volumeCostNote,
  MAX_LOOKS,
  maxCheckCost,
  pageOneGainsNotConfirmed,
  pageOneGainUnconfirmed,
  pagesForDepth,
  positionDelta,
  shareOfVoice,
  summarize,
  summarizeByDate,
  topCounts,
  visibility,
} from "./metrics";

describe("ctr", () => {
  it("falls with position and is zero when not ranking", () => {
    expect(ctr(1)).toBeGreaterThan(ctr(2));
    expect(ctr(2)).toBeGreaterThan(ctr(10));
    expect(ctr(10)).toBeGreaterThan(ctr(11));
    expect(ctr(20)).toBeGreaterThan(ctr(25));
    expect(ctr(25)).toBeGreaterThan(ctr(60));
    expect(ctr(null)).toBe(0);
    expect(ctr(0)).toBe(0);
    expect(ctr(101)).toBe(0);
  });

  it("never increases from one position to the next", () => {
    for (let p = 1; p < 100; p++) expect(ctr(p + 1)).toBeLessThanOrEqual(ctr(p));
  });
});

describe("visibility", () => {
  it("is 1 when every keyword is #1 and 0 when none rank", () => {
    expect(visibility([1, 1, 1])).toBe(1);
    expect(visibility([null, null])).toBe(0);
  });

  it("averages per keyword", () => {
    expect(visibility([1, null])).toBeCloseTo(0.5);
    expect(visibility([3])).toBeCloseTo(ctr(3) / ctr(1));
  });

  it("is null for an empty set", () => {
    expect(visibility([])).toBeNull();
  });
});

describe("estimatedTraffic", () => {
  it("multiplies CTR by volume and skips unknown volume", () => {
    const t = estimatedTraffic([
      { position: 1, volume: 1000 },
      { position: 5, volume: 200 },
      { position: 2, volume: null },
      { position: null, volume: 5000 },
    ]);
    expect(t).toBeCloseTo(1000 * ctr(1) + 200 * ctr(5));
  });
});

describe("shareOfVoice", () => {
  it("weights keywords by volume", () => {
    const big = shareOfVoice([
      { position: 1, volume: 900 },
      { position: null, volume: 100 },
    ])!;
    const small = shareOfVoice([
      { position: null, volume: 900 },
      { position: 1, volume: 100 },
    ])!;
    expect(big).toBeCloseTo((0.9 * ctr(1)) / CTR_TOP20_TOTAL);
    expect(small).toBeCloseTo((0.1 * ctr(1)) / CTR_TOP20_TOTAL);
    expect(big).toBeGreaterThan(small);
  });

  it("sums to 1 across domains that fill the top 20", () => {
    let total = 0;
    for (let p = 1; p <= 20; p++) total += shareOfVoice([{ position: p, volume: 500 }])!;
    expect(total).toBeCloseTo(1);
  });

  it("treats keywords equally when no volumes are known", () => {
    expect(
      shareOfVoice([
        { position: 1, volume: null },
        { position: null, volume: null },
      ]),
    ).toBeCloseTo(ctr(1) / 2 / CTR_TOP20_TOTAL);
  });

  it("is null for an empty set", () => {
    expect(shareOfVoice([])).toBeNull();
  });
});

describe("positions", () => {
  it("averages ranked keywords only", () => {
    expect(averagePosition([2, 4, null])).toBe(3);
    expect(averagePosition([null])).toBeNull();
  });

  it("counts cumulative top buckets", () => {
    expect(topCounts([1, 3, 4, 10, 11, 20, 21, 100, null])).toEqual({ top3: 2, top10: 4, top20: 6, top100: 8 });
  });

  it("assigns exclusive buckets", () => {
    expect([1, 3, 4, 10, 11, 20, 21, 100, null].map(bucketOf)).toEqual([
      "1-3",
      "1-3",
      "4-10",
      "4-10",
      "11-20",
      "11-20",
      "21-100",
      "21-100",
      "none",
    ]);
  });

  it("classifies changes, lower being better", () => {
    expect(classifyChange(5, 3)).toBe("improved");
    expect(classifyChange(3, 5)).toBe("declined");
    expect(classifyChange(4, 4)).toBe("unchanged");
    expect(classifyChange(null, 8)).toBe("new");
    expect(classifyChange(8, null)).toBe("lost");
    expect(classifyChange(null, undefined)).toBe("none");
    expect(positionDelta(5, 3)).toBe(2);
    expect(positionDelta(null, 3)).toBeNull();
  });
});

describe("summarizeByDate", () => {
  it("groups by date in order", () => {
    const s = summarizeByDate([
      { date: "2026-10-02", position: 1, volume: 100 },
      { date: "2026-10-01", position: null, volume: 100 },
      { date: "2026-10-02", position: null, volume: 100 },
    ]);
    expect(s.map((d) => d.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(s[0].visibility).toBe(0);
    expect(s[1].visibility).toBeCloseTo(0.5);
    expect(s[1].keywords).toBe(2);
    expect(s[1].top3).toBe(1);
  });
});

describe("not confirmed shares", () => {
  const rows = [
    { position: 1, volume: 100, notChecked: true },
    { position: 3, volume: 200 },
    { position: null, volume: 50 },
    { position: null, volume: 50, notChecked: true },
  ];

  it("splits out what rests on positions no look confirmed", () => {
    const s = summarize(rows);
    expect(s.trafficNotConfirmed).toBeCloseTo(ctr(1) * 100);
    expect(s.visibilityNotConfirmed).toBeCloseTo(1 / 4);
    expect(s.visibility).toBeCloseTo((ctr(1) + ctr(3)) / (4 * ctr(1)));
  });

  it("is zero with nothing unconfirmed or no rows", () => {
    expect(summarize([{ position: 2, volume: 10 }])).toMatchObject({ trafficNotConfirmed: 0, visibilityNotConfirmed: 0, shareOfVoiceNotConfirmed: 0, top3NotConfirmed: 0, rankingNotConfirmed: 0 });
    expect(summarize([])).toMatchObject({ trafficNotConfirmed: 0, visibilityNotConfirmed: 0, shareOfVoiceNotConfirmed: 0, top3NotConfirmed: 0, rankingNotConfirmed: 0, avgPositionConfirmed: null });
  });

  it("splits share of voice on the whole set's weights, so the two parts add up to the figure", () => {
    const s = summarize(rows);
    expect(s.shareOfVoiceNotConfirmed).toBeCloseTo((100 * ctr(1)) / (400 * CTR_TOP20_TOTAL));
    expect(s.shareOfVoice! - s.shareOfVoiceNotConfirmed).toBeCloseTo((200 * ctr(3)) / (400 * CTR_TOP20_TOTAL));
  });

  it("counts an unconfirmed keyword with no volume as nothing when others have one, as share of voice does", () => {
    const s = summarize([{ position: 1, volume: 0, notChecked: true }, { position: 3, volume: 200 }]);
    expect(s.shareOfVoiceNotConfirmed).toBe(0);
    expect(s.visibilityNotConfirmed).toBeCloseTo(1 / 2);
  });

  it("weighs keywords the same when none has a volume, as share of voice does", () => {
    const s = summarize([{ position: 1, volume: null, notChecked: true }, { position: 3, volume: null }]);
    expect(s.shareOfVoiceNotConfirmed).toBeCloseTo(ctr(1) / (2 * CTR_TOP20_TOTAL));
  });

  it("gives the average without them, and counts the ones the caption counts", () => {
    const s = summarize(rows);
    expect(s.avgPosition).toBe(2);
    expect(s.avgPositionConfirmed).toBe(3);
    expect(s).toMatchObject({ top3NotConfirmed: 1, rankingNotConfirmed: 1, top10NotConfirmed: 1 });
    expect(summarize([{ position: 4, volume: 1, notChecked: true }])).toMatchObject({ avgPosition: 4, avgPositionConfirmed: null, top3NotConfirmed: 0, top10NotConfirmed: 1, rankingNotConfirmed: 1 });
  });
});

describe("not confirmed counts", () => {
  it("counts the positions behind each figure, whatever they're worth", () => {
    const s = summarize([
      { position: 2, volume: 100, notChecked: true },
      { position: 8, volume: 100, notChecked: true },
      { position: 40, volume: 100, notChecked: true },
      { position: 1, volume: 100 },
    ]);
    expect(s).toMatchObject({ notConfirmed: 3, top3NotConfirmed: 1, top10NotConfirmed: 2, top3: 2, top10: 3 });
  });

  it("doesn't count a row with no position, which is in no figure", () => {
    expect(summarize([{ position: null, volume: 100, notChecked: true }])).toMatchObject({ notConfirmed: 0, top3NotConfirmed: 0, top10NotConfirmed: 0 });
  });

  it("reads zero when every position was confirmed", () => {
    expect(summarize([{ position: 1, volume: 100 }])).toMatchObject({ notConfirmed: 0, top3NotConfirmed: 0 });
  });
});

describe("pageOneGainsNotConfirmed", () => {
  const FROM = "2026-10-31";
  const TO = "2026-11-07";
  const row = (keywordId: number, date: string, position: number | null, notChecked = false) => ({ keywordId, date, position, notChecked });

  it("counts only unconfirmed keywords that weren't on page one at the start", () => {
    const rows = [
      row(1, FROM, 14),
      row(1, TO, 9, true), // gained, unconfirmed
      row(2, FROM, null),
      row(2, TO, 6, true), // gained, unconfirmed
      row(3, FROM, 4),
      row(3, TO, 4, true), // already there
      row(4, FROM, 14),
      row(4, TO, 8), // gained, confirmed
      row(5, FROM, 30),
      row(5, TO, 25, true), // unconfirmed, not on page one
    ];
    expect(pageOneGainsNotConfirmed(rows, FROM, TO)).toBe(2);
  });

  it("ignores checks between the two", () => {
    expect(pageOneGainsNotConfirmed([row(1, FROM, 14), row(1, "2026-11-03", 5, true), row(1, TO, 14)], FROM, TO)).toBe(0);
  });
});

describe("pageOneGainUnconfirmed", () => {
  const gain = (was: number, now: number, unconfirmed: number) => pageOneGainUnconfirmed({ previous: { top10: was }, latest: { top10: now }, pageOneGainsNotConfirmed: unconfirmed });

  it("is true when the gain wouldn't be there without them", () => {
    expect(gain(5, 8, 3)).toBe(true);
    // Four came in unconfirmed and one fell off, so the net gain of three is still all theirs.
    expect(gain(5, 8, 4)).toBe(true);
  });

  it("is false for a partial gain, no gain, a fall or nothing to compare", () => {
    expect(gain(5, 8, 2)).toBe(false);
    expect(gain(5, 8, 0)).toBe(false);
    expect(gain(5, 5, 2)).toBe(false);
    expect(gain(8, 5, 2)).toBe(false);
    expect(pageOneGainUnconfirmed({ previous: null, latest: { top10: 8 }, pageOneGainsNotConfirmed: 0 })).toBe(false);
  });
});

describe("cost", () => {
  it("bills per 10 results, rounded up", () => {
    expect(pagesForDepth(10)).toBe(1);
    expect(pagesForDepth(20)).toBe(2);
    expect(pagesForDepth(25)).toBe(3);
    expect(estimateCheckCost(10, 20)).toBeCloseTo(0.018);
    expect(estimateCheckCost(10, 100, true)).toBeCloseTo(0.072);
  });
  it("prices the upper bound as every keyword looked at three times", () => {
    expect(MAX_LOOKS).toBe(3);
    expect(maxCheckCost(10, 20)).toBeCloseTo(0.054);
    expect(maxCheckCost(10, 100, true)).toBeCloseTo(0.216);
  });
});

describe("volumeCostNote", () => {
  it("gives Labs' keyword overview formula, not one batch's base price", () => {
    expect(volumeCostNote(false)).toBe("≈ $0.012 per batch of up to 700 keywords plus $0.00012 per keyword, cached 30 days");
  });
  it("adds the Google Ads task a city's volumes take", () => {
    expect(volumeCostNote(true)).toBe("≈ $0.012 per batch of up to 700 keywords plus $0.00012 per keyword, and $0.09 per batch for the city's Google Ads volumes, cached 30 days");
  });
});
