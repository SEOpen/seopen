import { describe, expect, it } from "vitest";
import { imageAltCounts, missingAltDetail } from "./image-alt";

describe("imageAltCounts", () => {
  it("counts an image with no alt attribute, not one with alt=\"\"", () => {
    const html = '<img src="/deco.png" alt=""><img src="/logo.png" alt="Logo"><IMG SRC="/hero.jpg"><img data-src="/lazy.jpg"><img>';
    expect(imageAltCounts(html)).toEqual({ images: 5, missing: 3, named: ["/hero.jpg", "/lazy.jpg", "an image with no src"] });
  });

  it("reads alt in any quoting, and bare", () => {
    expect(imageAltCounts("<img src=a.png alt><img src='b.png' alt=''><img src=c.png ALT=x>").missing).toBe(0);
  });

  it("doesn't take data-alt, or alt inside another attribute's value, for alt", () => {
    expect(imageAltCounts('<img src="/a.png" data-alt="A"><img src="/b.png" title="no alt here">').named).toEqual(["/a.png", "/b.png"]);
  });

  it("skips images a visitor never sees: a noscript pixel, commented-out markup, a tag in a script string, a template", () => {
    const html = [
      '<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=1&ev=PageView&noscript=1"></noscript>',
      '<!-- <img src="/old.png"> -->',
      '<script>el.innerHTML = "<img src=" + x + ">";</script>',
      '<template><img src="/card.png"></template>',
      '<style>/* <img src="/s.png"> */</style>',
      '<img src="/real.png">',
    ].join("");
    expect(imageAltCounts(html)).toEqual({ images: 1, missing: 1, named: ["/real.png"] });
  });

  it("still reads images after an unclosed comment or script", () => {
    expect(imageAltCounts('<img src="/a.png"><!-- <img src="/b.png">').named).toEqual(["/a.png", "/b.png"]);
    expect(imageAltCounts('<script>var a = 1;<img src="/a.png">').named).toEqual(["/a.png"]);
  });

  it("reads a page of unclosed tags in linear time", () => {
    const started = Date.now();
    imageAltCounts("<img ".repeat(400_000));
    imageAltCounts("<img " + "a".repeat(2_000_000));
    imageAltCounts("<!--".repeat(400_000));
    imageAltCounts("<script>".repeat(200_000) + "<noscript>".repeat(200_000) + "<template ".repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("keeps the first three names and counts the rest", () => {
    const html = Array.from({ length: 500 }, (_, i) => `<img src="/${i}.png">`).join("");
    expect(imageAltCounts(html)).toEqual({ images: 500, missing: 500, named: ["/0.png", "/1.png", "/2.png"] });
  });

  it("doesn't name an inline image or print a long src whole", () => {
    expect(imageAltCounts('<img src="data:image/png;base64,AAAA"><img src="/' + "x".repeat(300) + '">').named).toEqual(["an inline image", `/${"x".repeat(199)}…`]);
  });
});

describe("missingAltDetail", () => {
  it("names up to three images and counts the rest", () => {
    expect(missingAltDetail({ missing: 0, named: [] })).toBeNull();
    expect(missingAltDetail({ missing: 1, named: ["/a.png"] })).toBe("/a.png");
    expect(missingAltDetail({ missing: 5, named: ["/a.png", "/b.png", "/c.png"] })).toBe("/a.png, /b.png, /c.png, +2 more");
  });
});
