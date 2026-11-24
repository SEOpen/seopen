import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Integration } from "./integration";

describe("Integration", () => {
  it("says a broken connection needs reconnecting, with a link to where", () => {
    const html = renderToStaticMarkup(<Integration name="Search Console" connected="example.com" connectHref="/gsc" reconnect />);
    expect(html).toContain("example.com");
    expect(html).toContain("Reconnect needed");
    expect(html).toContain('href="/gsc"');
  });

  it("says it without a link on an archived project", () => {
    const html = renderToStaticMarkup(<Integration name="Search Console" connected="example.com" connectHref={null} reconnect />);
    expect(html).toContain("Reconnect needed");
    expect(html).not.toContain("<a");
  });

  it("shows a healthy connection and an unconnected one as before", () => {
    const fine = renderToStaticMarkup(<Integration name="Search Console" connected="example.com" connectHref="/gsc" />);
    expect(fine).toContain("example.com");
    expect(fine).not.toContain("Reconnect");
    expect(renderToStaticMarkup(<Integration name="Analytics" connected={null} connectHref="/ga4" />)).toContain(">Connect<");
    expect(renderToStaticMarkup(<Integration name="Analytics" connected={null} connectHref={null} />)).toContain("Not connected");
  });
});
