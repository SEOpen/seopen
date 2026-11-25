import { describe, expect, it } from "vitest";
import { addressTowns, detectBusinessType, isBusinessType, matchTowns, namesToLookUp, parseSearches, parseTowns, townCandidates } from "./business";

const CLIENT_HR = {
  title: "Client HR - Best Human Resources Consultant Services Riverton Bay OH",
  description: "Client HR is Riverton, St Clair, and Fairview's trusted Human Resources consultant. HR consulting for startups, small businesses, and non-profits.",
};
const OHIO = [{ name: "Riverton, Ohio" }, { name: "St. Clair, Ohio" }, { name: "Fairview, Ohio" }];

describe("townCandidates and matchTowns", () => {
  it("finds the towns a local business names without structured data (Client HR)", () => {
    const candidates = townCandidates([CLIENT_HR.title, CLIENT_HR.description]);
    expect(namesToLookUp(candidates)).toEqual(expect.arrayContaining(["Riverton", "St Clair", "Fairview"]));
    expect(matchTowns(candidates, OHIO)).toEqual(["Riverton, Ohio", "St Clair, Ohio", "Fairview, Ohio"]);
  });

  it("drops a same-named town in another state when the text names one", () => {
    const candidates = townCandidates(["Plumbers in Riverton, OH"]);
    expect(matchTowns(candidates, [{ name: "Riverton, Indiana" }, { name: "Riverton, Ohio" }])).toEqual(["Riverton, Ohio"]);
    expect(matchTowns(candidates, [{ name: "Riverton, Indiana" }])).toEqual([]);
  });

  it("leaves a name in several states without one, for the user to settle", () => {
    expect(matchTowns(townCandidates(["Plumbers serving Springfield"]), [{ name: "Springfield, Illinois" }, { name: "Springfield, Missouri" }])).toEqual(["Springfield"]);
  });

  it("doesn't take capitals in a heading for a town", () => {
    expect(matchTowns(townCandidates(["Marketing Software", "Built For Teams"]), [{ name: "Marketing, Ohio" }, { name: "Teams, Ohio" }])).toEqual([]);
  });

  it("stops at the most asked for", () => {
    const places = ["Aa", "Bb", "Cc", "Dd"].map((t) => ({ name: `${t}, Ohio` }));
    expect(matchTowns(townCandidates(["Serving Aa, Bb, Cc and Dd"]), places, 2)).toHaveLength(2);
  });
});

describe("addressTowns", () => {
  it("reads the town from a street address", () => {
    expect(matchTowns(addressTowns("Visit 400 N Harbor Dr, Riverton, OH 44101 today"), OHIO)).toEqual(["Riverton, Ohio"]);
    expect(addressTowns("Call us any time")).toEqual([]);
  });

  it("reads names with accents, apostrophes, hyphens, dots and a capital inside, and one that follows another address", () => {
    const named = (text: string) => addressTowns(text).map((t) => [t.names[0], t.region]);
    expect(named("Cañon City, CO 81212")).toEqual([["Cañon City", "Colorado"]]);
    expect(named("Coeur d’Alene ID 83814 or O'Fallon, MO 63366")).toEqual([["Alene", "Idaho"], ["O'Fallon", "Missouri"]]);
    expect(named("Winston-Salem, NC 27101")).toEqual([["Winston-Salem", "North Carolina"]]);
    expect(named("St. Clair, OH 44101-Riverton, OH 44102")).toEqual([["St. Clair", "Ohio"], ["Riverton", "Ohio"]]);
    expect(named("visitMcAllen, TX 78501")).toEqual([["McAllen", "Texas"]]);
    expect(named("Our Very Own Office Riverton Bay, TX 77550")).toEqual([["Own Office Riverton Bay", "Texas"]]);
  });

  it("stops at 500 addresses", () => {
    expect(addressTowns("Riverton, OH 44101 ".repeat(600))).toHaveLength(500);
  });
});

describe("towns on hostile pages", () => {
  const MB = 1_000_000;

  it("reads 1 MB of text in linear time", () => {
    for (const text of ["A".repeat(MB), "A-".repeat(MB / 2), "Aa".repeat(MB / 2), "A ".repeat(MB / 2), "A, ".repeat(MB / 3), "A'A A. ".repeat(MB / 7), `A${"a".repeat(MB)}`, `${"a".repeat(MB)}A`, "A OH 12345 ".repeat(MB / 11)]) {
      const started = Date.now();
      addressTowns(text);
      expect(Date.now() - started, text.slice(0, 20)).toBeLessThan(1500);
    }
  });

  it("reads the start of a 1 MB title, cut between words", () => {
    for (const unit of ["A", "A-", "A ", "A, ", "A A A A A, ", "A and ", "in A, "]) {
      const started = Date.now();
      townCandidates([unit.repeat(MB / unit.length)]);
      expect(Date.now() - started, unit).toBeLessThan(1500);
    }
    expect(namesToLookUp(townCandidates([`Plumbers in Riverton. ${"x".repeat(1_970)} near Fairview`]))).toEqual(["Riverton"]);
  });

  it("matches many names against many places in linear time", () => {
    const names = Array.from({ length: 10_000 }, (_, i) => `Town${"abcdefghij"[i % 10]}${i}`);
    const places = names.map((name) => ({ name: `${name}, Iowa` }));
    const started = Date.now();
    expect(matchTowns(names.map((n) => ({ names: [n], region: "Ohio" })), places)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

describe("detectBusinessType", () => {
  const none = { hasLocalBusiness: false, towns: [] };

  it("takes named towns or a local schema type for a local business", () => {
    expect(detectBusinessType(`<a href="tel:+14095550100">Call</a>`, { hasLocalBusiness: false, towns: ["Riverton, Ohio"] })).toBe("local");
    expect(detectBusinessType("", { hasLocalBusiness: true, towns: [] })).toBe("local");
  });

  it("knows software by its schema type or its pricing and sign-in links", () => {
    expect(detectBusinessType(`<script type="application/ld+json">{"@type":"SoftwareApplication"}</script>`, none)).toBe("software");
    expect(detectBusinessType(`<a href="/pricing">Pricing</a><a href="/login">Log in</a>`, none)).toBe("software");
  });

  it("knows a store by its products, cart or platform", () => {
    expect(detectBusinessType(`<script type="application/ld+json">{"@type":"Product"}</script>`, none)).toBe("store");
    expect(detectBusinessType(`<a href="/cart">Cart</a>`, none)).toBe("store");
    expect(detectBusinessType(`<script src="https://cdn.shopify.com/x.js"></script>`, none)).toBe("store");
  });

  it("sends a software company with a phone number and an office to software", () => {
    expect(detectBusinessType(`<a href="tel:1">Call</a><a href="/pricing">Pricing</a><a href="/login">Log in</a><a href="/docs">Docs</a>`, { hasLocalBusiness: false, towns: ["Austin, Ohio"] })).toBe("software");
  });

  it("calls weak signals something else", () => {
    expect(detectBusinessType(`<a href="/about">About</a><a href="tel:1">Call</a>`, none)).toBe("other");
    expect(detectBusinessType(`<a href="/pricing">Pricing</a><a href="/try">Free to try</a>`, none)).toBe("other");
  });

  it("reads a free trial in a link's words", () => {
    for (const text of ["Try it free", "Start free", "Free trial", "Use it for free"]) expect(detectBusinessType(`<a href="/pricing">Pricing</a><a href="/x">${text}</a>`, none), text).toBe("software");
  });
});

describe("parseTowns", () => {
  it("reads one town per line, keeping commas, without repeats or blanks, at most five", () => {
    expect(parseTowns(" Riverton, Ohio \n\nFairview\nRiverton, Ohio\nx")).toEqual(["Riverton, Ohio", "Fairview"]);
    expect(parseTowns("Aa\nBb\nCc\nDd\nEe\nFf")).toHaveLength(5);
  });
});

describe("isBusinessType", () => {
  it("accepts only the four types", () => {
    expect(isBusinessType("local")).toBe(true);
    expect(isBusinessType("restaurant")).toBe(false);
    expect(isBusinessType(null)).toBe(false);
  });
});

describe("parseSearches", () => {
  it("reads lines and commas, as Google writes keywords, up to the limit", () => {
    expect(parseSearches(" Basecamp  Report \n\nbasecamp report, x\nbasecamp export\nbasecamp restore\nbasecamp sync")).toEqual(["basecamp report", "basecamp export", "basecamp restore"]);
  });
});

describe("detectBusinessType on hostile pages", () => {
  it("reads unclosed links and a long @type stretch in linear time", () => {
    const facts = { hasLocalBusiness: false, towns: [] };
    const started = Date.now();
    detectBusinessType("<a>".repeat(200_000), facts);
    detectBusinessType('"@type":'.repeat(200_000), facts);
    detectBusinessType(`<a>${"try ".repeat(250_000)}</a>`, facts);
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
