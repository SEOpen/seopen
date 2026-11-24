import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { dashboard } from "./dashboard";
import { fixtures } from "./dashboard.fixtures";

vi.mock("server-only", () => ({}));

const card = (data: typeof fixtures.full) => renderToStaticMarkup(<dashboard.View data={data} />);

describe("the Rankings card", () => {
  it("says how much of its numbers no look confirmed, under each one", () => {
    const html = card({ ...fixtures.full, latest: { ...fixtures.full.latest, visibilityNotConfirmed: 0.0724, top3NotConfirmed: 2 } });
    expect(html).toContain("7.2 pts not confirmed");
    expect(html).toContain("2 not confirmed");
  });

  it("says nothing when nothing is unconfirmed or it rounds away", () => {
    expect(card(fixtures.full)).not.toContain("not confirmed");
    expect(card({ ...fixtures.full, latest: { ...fixtures.full.latest, visibilityNotConfirmed: 0.0004 } })).not.toContain("not confirmed");
  });

  it("has a state to preview", () => {
    expect(card(fixtures.more!["positions not confirmed"])).toContain("not confirmed");
  });
});

describe("the Rankings card's changes", () => {
  const onPageOne = (d: typeof fixtures.full) => dashboard.changes!(d).find((c) => c?.label === "On page one");
  const gain = { ...fixtures.full, latest: { ...fixtures.full.latest, top10: 24 }, previous: { ...fixtures.full.previous!, top10: 20 } };

  it("doesn't call a gain good when no look confirmed any of it", () => {
    expect(onPageOne({ ...gain, pageOneGainsNotConfirmed: 4 })).toMatchObject({ goodWhen: "neither" });
    expect(onPageOne({ ...gain, pageOneGainsNotConfirmed: 3 })).toMatchObject({ goodWhen: "up" });
    expect(onPageOne(gain)).toMatchObject({ goodWhen: "up" });
  });
});
