import { describe, expect, it } from "vitest";
import { comparedSites, headings, linkedTopics, localBusiness, servedCities, siteFacts, describedOffer, serviceNames } from "./site";

const ld = (v: unknown) => `<script type="application/ld+json">${JSON.stringify(v)}</script>`;

describe("headings", () => {
  it("reads H1 to H3 text in order, without markup or repeats", () => {
    const html = "<h1>Web design <em>in</em> Salem</h1><h2>Services</h2><h4>skip</h4><h3>Services</h3><h3>SEO &amp; content</h3>";
    expect(headings(html)).toEqual(["Web design in Salem", "Services", "SEO & content"]);
  });
});

describe("localBusiness", () => {
  it("finds a local business with a town, in a @graph too", () => {
    const html = ld({
      "@context": "https://schema.org",
      "@graph": [
        { "@type": "WebSite", name: "Beta Web" },
        { "@type": "ProfessionalService", name: "Beta Web Design", address: { "@type": "PostalAddress", addressLocality: "Salem", addressRegion: "NH" } },
      ],
    });
    expect(localBusiness(html)).toEqual({ name: "Beta Web Design", city: "Salem, NH" });
  });

  it("counts an organization with opening hours, and skips one without a town", () => {
    expect(localBusiness(ld({ "@type": "Organization", name: "Acme", openingHours: "Mo-Fr 09:00-17:00", address: { addressLocality: "Austin" } }))).toEqual({
      name: "Acme",
      city: "Austin",
    });
    expect(localBusiness(ld({ "@type": "Plumber", name: "Pipes", address: { addressRegion: "TX" } }))).toBeNull();
  });

  it("ignores an online-only organization and broken JSON", () => {
    expect(localBusiness(ld({ "@type": "Organization", name: "SaaS Inc", address: { addressLocality: "Remote" } }))).toBeNull();
    expect(localBusiness('<script type="application/ld+json">{nope</script>')).toBeNull();
  });
});

// The shape of one site's JSON-LD: a service-area business with no street
// address, serving towns given as City entities by reference.
const serviceArea = ld({
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "Organization", "@id": "#organization", name: "Glowworm Lab" },
    {
      "@type": "ProfessionalService",
      "@id": "#business",
      name: "Glowworm Lab",
      areaServed: [{ "@id": "#place-st-clair" }, { "@id": "#place-riverton" }, { "@id": "#place-lake-county" }, { "@id": "#place-riverton-bay-area" }],
    },
    { "@type": "State", "@id": "#place-ohio", name: "Ohio" },
    { "@type": "Place", "@id": "#place-riverton-bay-area", name: "Riverton Bay Area", containedInPlace: { "@id": "#place-ohio" } },
    { "@type": "AdministrativeArea", "@id": "#place-lake-county", name: "Lake County", containedInPlace: { "@id": "#place-ohio" } },
    { "@type": "AdministrativeArea", "@id": "#place-riverton-county", name: "Riverton County", containedInPlace: { "@id": "#place-ohio" } },
    { "@type": "City", "@id": "#place-st-clair", name: "St. Clair", containedInPlace: { "@id": "#place-lake-county" } },
    { "@type": "City", "@id": "#place-riverton", name: "Riverton", containedInPlace: { "@id": "#place-riverton-county" } },
  ],
});

describe("servedCities", () => {
  it("reads the towns a service-area business serves, with their state, and counts it as local", () => {
    expect(servedCities(serviceArea)).toEqual(["St. Clair, Ohio", "Riverton, Ohio"]);
    expect(localBusiness(serviceArea)).toEqual({ name: "Glowworm Lab", city: "St. Clair, Ohio" });
  });

  it("puts the address first, takes \"Town, ST\" strings, and skips vague areas", () => {
    const html = ld({
      "@type": "Plumber",
      name: "Pipes",
      address: { addressLocality: "Austin", addressRegion: "TX" },
      areaServed: ["Round Rock, TX", "Austin, TX", "Central Texas", { "@type": "City", name: "Cedar Park" }, { "@type": "State", name: "Ohio" }],
    });
    expect(servedCities(html)).toEqual(["Austin, TX", "Round Rock, TX", "Cedar Park"]);
  });

  it("ignores places of a business that isn't local", () => {
    expect(servedCities(ld({ "@type": "Organization", name: "SaaS Inc", areaServed: { "@type": "City", name: "Remote" } }))).toEqual([]);
  });
});

describe("siteFacts", () => {
  it("puts the page's title, description, headings and business together", () => {
    const html = `<html><head><title>Acme Plumbing</title><meta name="description" content="Plumbers in Austin."></head><body><h1>Plumbers</h1>${ld({ "@type": "Plumber", name: "Acme Plumbing", address: { addressLocality: "Austin", addressRegion: "TX" } })}</body></html>`;
    expect(siteFacts(html)).toEqual({ title: "Acme Plumbing", description: "Plumbers in Austin.", headings: ["Plumbers"], business: { name: "Acme Plumbing", city: "Austin, TX" }, cities: ["Austin, TX"], services: [], offer: null, audiences: [] });
  });
});

describe("serviceNames", () => {
  it("reads the h4s under a services heading, stopping at the next section", () => {
    const html = `<h1>Client HR</h1><h3>HR Services Offered</h3><h4>Compliance</h4><h4>Training &amp; Development</h4><h4>Why choose us?</h4><h3>About</h3><h4>Our story</h4>`;
    expect(serviceNames(html)).toEqual(["compliance", "training and development"]);
  });

  it("finds nothing when no heading introduces services", () => {
    expect(serviceNames("<h2>About</h2><h3>Our story</h3>")).toEqual([]);
  });
});

describe("describedOffer", () => {
  it("takes a short service and who it's for from a sentence of the description", () => {
    expect(describedOffer("Client HR is Riverton's premier consultant. HR consulting for startups, small businesses, and non-profits.")).toEqual({
      offer: "hr consulting",
      audiences: ["startups", "small businesses", "non-profits"],
    });
  });

  it("doesn't take a sentence about the business for a service", () => {
    expect(describedOffer("We are the best choice for families.")).toEqual({ offer: null, audiences: [] });
    expect(describedOffer(null)).toEqual({ offer: null, audiences: [] });
  });
});

describe("linkedTopics", () => {
  it("reads subjects from links into guides and the like, this site's only", () => {
    const html = `
      <a href="/guides/basecamp-change-history">a</a>
      <a href="https://www.reportwell.app/guides/basecamp_snapshots/">b</a>
      <a href="/guides">all guides</a>
      <a href="/guides/basecamp-change-history">again</a>
      <a href="https://other.com/guides/not-ours">c</a>
      <a href="/pricing">d</a>
      <a href="mailto:hello@reportwell.app">e</a>`;
    expect(linkedTopics(html, "reportwell.app")).toEqual(["basecamp change history", "basecamp snapshots"]);
  });
});

describe("comparedSites", () => {
  it("keeps the sites the page compares, not the others it links to", () => {
    // Shaped like a product's /vs page.
    const page = `
      <a href="/vs/etareports">x</a><a href="/vs/madeup-reports">x</a><a href="/vs/thetareport">x</a>
      <a href="https://etareports.example/pricing">x</a>
      <a href="https://apps.apple.com/us/app/solid-report/id1000000000">x</a>
      <a href="https://reportwell.app/vs">x</a>
      <a href="https://madeup-reports.com/pricing">x</a>
      <a href="https://madeup-reports.com/content/help">x</a>
      <a href="https://support.basecamp.com/docs/snapshots">x</a>
      <a href="https://www.thetareport.example/pricing">x</a>
      <a href="mailto:hello@reportwell.app">x</a>`;
    expect(comparedSites(page, "reportwell.app")).toEqual(["etareports.example", "madeup-reports.com", "thetareport.example"]);
  });

  it("takes a name from a heading on a page with no comparison of its own", () => {
    expect(comparedSites(`<h2>Acme vs Rival</h2><a href="https://rival.com/">x</a><a href="https://stripe.com/">x</a>`, "acme.com")).toEqual(["rival.com"]);
  });
});

describe("hostile homepages", () => {
  const MB = 1_000_000;
  const fast = (name: string, run: () => unknown) => {
    const started = Date.now();
    run();
    expect(Date.now() - started, name).toBeLessThan(1500);
  };
  const many = (bytes: number, unit: (i: number) => string) => Array.from({ length: Math.floor(bytes / unit(0).length) }, (_, i) => unit(i)).join("");

  it("reads 1 MB of them in linear time", () => {
    fast("description", () => describedOffer(`Web design for startups${" ".repeat(MB)}x`));
    fast("topics", () => linkedTopics(many(MB, (i) => `<a href="/blog/${i}">`), "acme.com"));
    const children = many(MB / 2, (i) => `<a href="/vs/q${i}">`);
    fast("comparisons", () => comparedSites(children + many(MB / 2, (i) => `<a href="//z${i}.example">`), "acme.com"));
    const labels = (i: number) => Array.from({ length: 60 }, (_, l) => "a" + "ab".repeat(1 + (l % 2)) + (l === 0 ? i : "")).join(".").slice(0, 200);
    fast("many labels", () => comparedSites(many(100_000, (i) => `<a href="/vs/${"a".repeat(195)}${i % 900}">`) + many(60_000, (i) => `<a href="//${labels(i)}.example">`), "acme.com"));
    fast("one long comparison", () => comparedSites(`<a href="/vs/${"q".repeat(MB / 2)}">` + many(MB / 2, (i) => `<a href="//z${i}.example">`), "acme.com"));
  });

  it("skips structured data nested too deep to read, and keeps the rest", () => {
    const block = (json: string) => `<script type="application/ld+json">${json}</script>`;
    const html = block("[".repeat(200_000) + "]".repeat(200_000)) + block('{"@type":"Plumber","name":"Fernhill","address":{"addressLocality":"Riverton"}}');
    expect(localBusiness(html)?.name).toBe("Fernhill");
    expect(servedCities(html)).toEqual(["Riverton"]);
    expect(siteFacts(html)).toMatchObject({ business: { name: "Fernhill" }, cities: ["Riverton"] });
  });

  it("cuts a title and description at 2,000 characters, and drops a name too long to be one", () => {
    const long = "x".repeat(5_000);
    const business = `<script type="application/ld+json">{"@type":"Plumber","name":"${long}","address":{"addressLocality":"Riverton"}}</script>`;
    const facts = siteFacts(`<head><title>${long}</title><meta name="description" content="${long}"></head>${business}`);
    expect([facts.title?.length, facts.description?.length]).toEqual([2_000, 2_000]);
    expect(facts.business).toBeNull();
    expect(facts.cities).toEqual(["Riverton"]);
  });
});
