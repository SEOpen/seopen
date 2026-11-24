import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PRICE_PER_PAGE, priceText } from "../transform";
import { CrawlForm } from "./crawl-form";

vi.mock("../actions", () => ({ startCrawl: vi.fn() }));
vi.mock("@/components/plan-upgrade", () => ({ UpgradeNow: () => null }));

const form = (refused: boolean) => renderToStaticMarkup(<CrawlForm defaultMaxPages={100} defaultJs={false} showCost={false} planPages={500} first refused={refused} />);

describe("CrawlForm while the workspace can't spend", () => {
  it("is off, with nothing beside it repeating the banner", () => {
    const html = form(true);
    expect(html).toMatch(/<fieldset[^>]*\bdisabled=""/);
    expect(html).not.toContain('role="status"');
  });

  it("is on otherwise", () => {
    expect(form(false)).not.toMatch(/<fieldset[^>]*\bdisabled=""/);
  });
});

describe("CrawlForm's time line", () => {
  const free = renderToStaticMarkup(<CrawlForm defaultMaxPages={500} defaultJs={false} showCost={false} planPages={100} allowJavascript={false} first />);

  it("doesn't tell a Free workspace, at 100 pages, how long 500 pages take", () => {
    expect(free).not.toMatch(/500|10–30|minutes/);
    expect(free).toContain("2 seconds between pages");
  });

  it("keeps the 500-page time where the plan crawls 500", () => {
    expect(form(false)).toContain("A 500-page crawl usually takes 10 to 20 minutes.");
  });
});

describe("CrawlForm's price line", () => {
  const priced = (js: boolean) => renderToStaticMarkup(<CrawlForm defaultMaxPages={100} defaultJs={js} showCost planPages={null} first />);

  it("names the per-page rate the estimate uses", () => {
    expect(priced(false)).toContain(`${priceText(PRICE_PER_PAGE.resources)}/page with images, CSS and JS checked`);
    expect(priced(false)).toContain("Up to $0.045 at $0.00045/page with images, CSS and JS checked.");
    expect(priced(true)).toContain(`the JavaScript rate (${priceText(PRICE_PER_PAGE.javascript)}/page)`);
    expect(priced(true)).toContain("Up to $0.15 at the JavaScript rate ($0.0015/page).");
  });
});
