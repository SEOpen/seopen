import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chartDay, compare, describeChange, Kpi, KpiRow, ModuleFrame, ModuleListItem, ModuleRows, shownChange } from "./module-card";

const words = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("Kpi", () => {
  it("draws label, value, change and hint as one figure", () => {
    const html = renderToStaticMarkup(<Kpi label="Tracked position" value="14.6" delta={{ text: "1.5 better", tone: "good", up: true }} hint="spam score 4" />);
    expect(words(html)).toBe("Tracked position 14.6 up 1.5 better (better) spam score 4");
    expect(html).toContain("text-good");
    // The value and the change sit together, in the one figure treatment.
    expect(html).toContain("figure whitespace-nowrap");
  });

  it("leaves the change out when there's nothing earlier", () => {
    expect(words(renderToStaticMarkup(<Kpi label="Cited" value="17.5%" delta={null} />))).toBe("Cited 17.5%");
  });

  it("lines up across a row, so a long label doesn't push its value down", () => {
    const row = renderToStaticMarkup(
      <KpiRow>
        <Kpi label="Clicks" value="1" />
      </KpiRow>,
    );
    expect(row).toContain("grid-rows-subgrid");
    expect(row).not.toContain("<dl");
  });
});

describe("ModuleFrame", () => {
  const frame = (baseline?: string | null) =>
    renderToStaticMarkup(
      <ModuleFrame label="Rankings" href="/rank" description="31 keywords" baseline={baseline}>
        <p>Figures</p>
      </ModuleFrame>,
    );

  it("is a row with no box: the title link and what it covers, then the figures", () => {
    const html = frame("Oct 20");
    expect(html).not.toContain("panel");
    expect(html).toContain("@3xl/main:grid-cols-[13.75rem_minmax(0,1fr)]");
    expect(words(html)).toBe("Rankings 31 keywords · vs Oct 20 Figures");
  });

  it("has the one link, with its arrow inside for the eye only", () => {
    const html = frame();
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*href="\/rank"[^>]*>Rankings<svg[^>]*aria-hidden="true"/);
  });

  it("says when there's nothing earlier", () => {
    expect(words(frame(null))).toContain("nothing earlier to compare");
  });
});

describe("ModuleRows", () => {
  it("heads the list with a section title and how many rows it has", () => {
    const html = renderToStaticMarkup(
      <ModuleRows title="Couldn't load">
        <li>Rankings</li>
      </ModuleRows>,
    );
    expect(words(html)).toBe("Couldn&#x27;t load (1) Rankings");
    expect(html).toContain("text-[15px]");
    expect(html).not.toContain("caps-label");
  });
});

describe("describeChange", () => {
  it("signs and colors by goodWhen", () => {
    expect(describeChange(0.115, "percent", "up")).toEqual({ text: "+12%", tone: "good" });
    expect(describeChange(-0.04, "percent", "up")).toEqual({ text: "−4%", tone: "bad" });
    expect(describeChange(-1.7, "decimal", "down")).toEqual({ text: "−1.7", tone: "good" });
    expect(describeChange(3, "number", "neither")).toEqual({ text: "+3", tone: "muted" });
  });

  it("formats each unit", () => {
    expect(describeChange(0.014, "points", "up").text).toBe("+1.4 pts");
    expect(describeChange(12.367, "percent", "up").text).toBe("+1,237%");
    expect(describeChange(0.054, "percent", "up").text).toBe("+5.4%");
    expect(describeChange(-1234, "number", "up").text).toBe("−1,234");
  });

  it("says one point in the singular, going by what's printed", () => {
    expect(describeChange(0.01, "points", "up").text).toBe("+1 pt");
    expect(describeChange(-0.0104, "points", "up").text).toBe("−1 pt");
    expect(describeChange(0.07 - 0.06, "points", "up").text).toBe("+1 pt");
    expect(describeChange(0.011, "points", "up").text).toBe("+1.1 pts");
    expect(describeChange(0.02, "points", "up").text).toBe("+2 pts");
  });

  it("reads a change that rounds to zero as no change", () => {
    expect(describeChange(0, "number", "up")).toEqual({ text: "No change", tone: "muted" });
    expect(describeChange(0.0004, "percent", "up")).toEqual({ text: "No change", tone: "muted" });
    expect(describeChange(-0.02, "decimal", "down")).toEqual({ text: "No change", tone: "muted" });
  });
});

describe("shownChange", () => {
  it("drops a small count to the plain difference, as its figure does", () => {
    expect(shownChange({ from: 14, to: 37, unit: "percent" })).toEqual({ value: 23, unit: "number" });
    expect(shownChange({ from: 100, to: 150, unit: "percent" })).toEqual({ value: 0.5, unit: "percent" });
  });

  it("keeps money a percentage and leaves other units alone", () => {
    expect(shownChange({ from: 10, to: 20, unit: "percent", money: true })).toEqual({ value: 1, unit: "percent" });
    expect(shownChange({ from: 0.1, to: 0.15, unit: "points" }).unit).toBe("points");
  });

  it("follows the count rule for a count: the plain difference under 50, a percentage above", () => {
    const text = (to: number, from: number) => {
      const c = compare("Errors", to, from, { count: true, goodWhen: "down" })!;
      const { value, unit } = shownChange(c);
      return describeChange(value, unit, c.goodWhen).text;
    };
    expect(text(900, 1000)).toBe("−10%");
    expect(text(80, 60)).toBe("+33%");
    expect(text(37, 14)).toBe("+23");
    expect(text(60, 40)).toBe("+20");
  });

  it("keeps a count that starts from zero or ends there, unlike a percentage", () => {
    expect(compare("Errors", 5, 0, { unit: "percent" })).toBeNull();
    expect(shownChange(compare("Errors", 5, 0, { count: true })!)).toEqual({ value: 5, unit: "number" });
    expect(shownChange(compare("Keywords", 60, 0, { count: true })!)).toEqual({ value: 60, unit: "number" });
    expect(shownChange(compare("Keywords", 0, 60, { count: true })!)).toEqual({ value: -60, unit: "number" });
  });

  it("leaves a plain number plain without the count form", () => {
    expect(shownChange(compare("On page one", 80, 60)!)).toEqual({ value: 20, unit: "number" });
  });
});

describe("ModuleListItem", () => {
  it("gives the numbers in a caption the data size, in Outfit", () => {
    const html = renderToStaticMarkup(<ModuleListItem href="/x" label="List" meta="33 keywords · 12,550 searches/mo" />);
    expect(html).toContain('<span class="digits">33</span>');
    expect(html).toContain('<span class="digits">12,550</span>');
    expect(words(html)).toBe("List 33 keywords · 12,550 searches/mo");
  });
});

describe("chartDay", () => {
  it("keeps the calendar day", () => {
    expect(chartDay("2026-10-01")).toBe("Oct 1");
    expect(chartDay("2026-12-31")).toBe("Dec 31");
  });
});
