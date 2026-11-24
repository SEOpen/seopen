import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brandTokens, competitorQueries, homepageSeeds, isBranded, isLookalike, mapsKeywords, MAX_COMPETITOR_NAME, plainProposal, PROPOSAL_LIMITS, suggestedSearches, type MapsSearch, type SetupInput } from "./propose";
import { foreignPlace } from "./places";
import type { SiteFacts } from "./site";

const base: SetupInput = {
  domain: "betaweb.example",
  projectName: "Beta Web Design",
  site: null,
  keywords: [],
  ideas: [],
  competitors: [],
  existing: { competitors: [], keywords: [], prompts: [] },
  room: { keywords: 100, prompts: 25 },
};

describe("brand", () => {
  it("knows the project's name and domain label in any spacing", () => {
    const brand = brandTokens("Beta Web Design", "betaweb.example");
    expect(isBranded("beta web design reviews", brand)).toBe(true);
    expect(isBranded("betaweb", brand)).toBe(true);
    expect(isBranded("salem web design", brand)).toBe(false);
  });
});

describe("foreignPlace", () => {
  it("names a place in another country, and keeps the project's own country and towns", () => {
    expect(foreignPlace("website seo london", 2840)).toBe("london");
    expect(foreignPlace("ecommerce web development company bangalore", 2840)).toBe("bangalore");
    expect(foreignPlace("seo website uk", 2840)).toBe("uk");
    expect(foreignPlace("seo website uk", 2826)).toBeNull();
    expect(foreignPlace("web design new mexico", 2840)).toBeNull();
    expect(foreignPlace("web design mexico", 2840)).toBe("mexico");
    expect(foreignPlace("salem web design", 2840)).toBeNull();
    expect(foreignPlace("london web design", 2124, ["London, Ontario"])).toBeNull();
    expect(foreignPlace("website seo london", undefined)).toBeNull();
  });
});

describe("guided setup and Google data", () => {
  it("reads none, since what it reads goes to DataForSEO and the privacy page says Google data never does", () => {
    const dir = join(process.cwd(), "src/modules/setup");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes(".test."));
    expect(sources).toContain("gather.ts");
    for (const file of sources) {
      expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/modules\/google|gsc[A-Z]|ga4[A-Z]|gscProperty/);
    }
  });
});

describe("plainProposal", () => {
  it("leaves out Google's ideas that name another country's places, and says so", () => {
    const p = plainProposal({
      ...base,
      locationCode: 2840,
      ideas: [
        { keyword: "website seo london", volume: 900 },
        { keyword: "seo website uk", volume: 500 },
        { keyword: "salem seo company", volume: 100 },
      ],
    });
    expect(p.ideas.map((k) => k.keyword)).toEqual(["salem seo company"]);
    expect(p.notes).toContain("Left out keyword ideas naming places outside United States (london, uk).");
  });

  it("keeps real competitors: not the site itself, platforms or ones already tracked", () => {
    const p = plainProposal({
      ...base,
      keywords: [
        { keyword: "salem web design", volume: 300 },
        { keyword: "web designer salem", volume: 100 },
      ],
      competitors: [
        { domain: "betaweb.example", keywords: 2 },
        { domain: "blog.betaweb.example", keywords: 2 },
        { domain: "yelp.com", keywords: 2 },
        { domain: "Rival.com", keywords: 1 },
        { domain: "tracked.com", keywords: 2 },
        { domain: "other.com", keywords: 2 },
      ],
      existing: { ...base.existing, competitors: ["tracked.com"] },
    });
    expect(p.competitors.map((c) => c.domain)).toEqual(["other.com", "rival.com"]);
    expect(p.competitors.map((c) => c.reason)).toEqual(["Ranks in Google for all of 2 searches for your business", "Ranks in Google for 1 of 2 searches for your business"]);
  });

  it("proposes keywords by volume, deduped, minus tracked ones, within the plan's room", () => {
    const p = plainProposal({
      ...base,
      keywords: [
        { keyword: "web design salem", volume: 500 },
        { keyword: "Web  Design Salem", volume: 400 },
        { keyword: "salem seo", volume: 300 },
        { keyword: "tracked one", volume: 900 },
        { keyword: "logo design salem", volume: 100 },
      ],
      existing: { ...base.existing, keywords: ["tracked one"] },
      room: { keywords: 2, prompts: 25 },
    });
    expect(p.keywords.map((k) => k.keyword)).toEqual(["web design salem", "salem seo"]);
    expect(p.notes).toContain("Your plan has room for 2 more keywords.");
  });

  it("offers ideas the site doesn't rank for, in Google's order, within the room", () => {
    const p = plainProposal({
      ...base,
      keywords: [{ keyword: "web design salem", volume: 500 }],
      ideas: [
        { keyword: "Web Design Salem", volume: 500 },
        { keyword: "tracked one", volume: 900 },
        { keyword: "salem website designer", volume: 90 },
        { keyword: "small business websites", volume: 2000 },
        { keyword: "third idea", volume: 10 },
      ],
      existing: { ...base.existing, keywords: ["tracked one"] },
      room: { keywords: 2, prompts: 25 },
    });
    expect(p.ideas.map((k) => k.keyword)).toEqual(["salem website designer", "small business websites"]);
    expect(p.keywordRoom).toBe(2);
  });

  it("points a site that ranks for nothing at the ideas, and asks questions from them", () => {
    const p = plainProposal({ ...base, ideas: [{ keyword: "salem web design", volume: 300 }] });
    expect(p.keywords).toEqual([]);
    expect(p.notes[1]).toMatch(/Pick from the keyword ideas/);
    expect(p.prompts.map((x) => x.keyword)).toEqual(["salem web design"]);
  });

  it("turns unbranded keywords into questions, skipping ones already asked", () => {
    const p = plainProposal({
      ...base,
      keywords: [
        { keyword: "beta web design", volume: 900 },
        { keyword: "best web designer salem", volume: 300 },
        { keyword: "salem web design", volume: 200 },
      ],
      existing: { ...base.existing, prompts: ["What is the best salem web design?"] },
    });
    expect(p.keywords).toHaveLength(3);
    expect(p.prompts.map((x) => x.prompt)).toEqual(["Who is the best web designer salem?"]);
    expect(p.prompts[0].keyword).toBe("best web designer salem");
  });

  it("caps each section, says why a section is empty, and passes the business through", () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ keyword: `widget ${i}`, volume: 1000 - i }));
    const p = plainProposal({ ...base, keywords: many, site: { title: null, description: null, headings: [], business: { name: "Beta Web Design", city: "Salem, NH" }, cities: [] } });
    expect(p.keywords).toHaveLength(PROPOSAL_LIMITS.keywords);
    expect(p.prompts).toHaveLength(PROPOSAL_LIMITS.prompts);
    expect(p.local).toEqual({ name: "Beta Web Design", city: "Salem, NH" });
    expect(plainProposal(base).notes).toEqual([
      "No searches to check for competitors yet. Name what people search for to find you and make a new proposal, or add the competitors you know in Project settings.",
      "The site doesn't rank for keywords Google reports yet, so add the ones you want to track.",
    ]);
  });
});

// Shaped like a local agency's homepage: a title, description and the towns in its JSON-LD
// areaServed (no street address). The brand look-alike competitors and keywords are the kind a first
// run proposes; the copy, the volumes and the other rival domains are made up.
const glowworm: SiteFacts = {
  title: "St. Clair Web Design Agency | Glowworm Lab",
  description:
    "Glowworm Lab designs and builds websites for St. Clair and Riverton Bay companies, with search set up from the first page.",
  headings: ["St. Clair web design that gets you found.", "Four services, one build", "Web Design & Development", "E-Commerce"],
  business: { name: "Glowworm Lab", city: "St. Clair, Ohio" },
  cities: ["St. Clair, Ohio", "Riverton, Ohio", "Baytown, Ohio"],
};

const glowInput: SetupInput = {
  ...base,
  domain: "glowwormlab.example",
  projectName: "Glowworm Lab",
  site: glowworm,
  keywords: [
    { keyword: "glowworm", volume: 90000 },
    { keyword: "glow stick", volume: 40000 },
    { keyword: "glowworm web", volume: 90 },
    { keyword: "glow worm agency", volume: 70 },
    { keyword: "glowworm lab", volume: 50 },
    { keyword: "glowworm co", volume: 40 },
    { keyword: "custom web design riverton", volume: 30 },
    { keyword: "web design st clair tx", volume: 20 },
  ],
  ideas: [
    { keyword: "glowworm lab reviews", volume: 10 },
    { keyword: "glow stick bulk", volume: 5000 },
    { keyword: "web design riverton", volume: 900 },
    { keyword: "website developer baytown", volume: 50 },
  ],
  competitors: [
    { domain: "glowworm.example", keywords: 8 },
    { domain: "glowworm.test", keywords: 8 },
    { domain: "glowwoorm.example", keywords: 7 },
    { domain: "glowworm-co.example", keywords: 7 },
    { domain: "glowworms.example", keywords: 7 },
    { domain: "clutch.co", keywords: 9 },
    { domain: "bayou-web-studio.example", keywords: 6 },
    { domain: "riverton-site-builders.example", keywords: 4 },
  ],
};

describe("a local service business named like something else (Glowworm Lab)", () => {
  const brand = brandTokens("Glowworm Lab", "glowwormlab.example", glowworm);

  it("knows the brand by its distinctive part, in any spacing", () => {
    expect(brand).toContain("glowworm");
    for (const k of ["glowworm web", "glow worm agency", "glowworm", "glowworm lab reviews"]) expect(isBranded(k, brand)).toBe(true);
    for (const k of ["web design riverton", "custom web design riverton", "glow stick"]) expect(isBranded(k, brand)).toBe(false);
  });

  it("calls namesake domains look-alikes, not competitors", () => {
    for (const d of ["glowworm.example", "glowworm.test", "glowwoorm.example", "glowworm-co.example", "www.glowworm.example"]) expect(isLookalike(d, brand)).toBe(true);
    expect(isLookalike("bayou-web-studio.example", brand)).toBe(false);
    expect(isLookalike("wormish.example", brand)).toBe(false);
  });

  it("makes searches from the title and the towns it serves", () => {
    expect(homepageSeeds(glowworm, brand)).toEqual([
      "st clair web design agency",
      "web design st clair",
      "web design agency st clair",
      "web design riverton",
      "web design agency riverton",
      "web design baytown",
      "web design agency baytown",
    ]);
    expect(homepageSeeds({ ...glowworm, cities: [], business: null }, brand)).toEqual([]);
  });

  it("looks up competitors with the business's searches, not its name", () => {
    const queries = competitorQueries(glowInput);
    expect(queries.slice(0, 2)).toEqual(["st clair web design agency", "web design st clair"]);
    expect(queries).toContain("custom web design riverton");
    expect(queries).toContain("website developer baytown");
    expect(queries.filter((q) => isBranded(q, brand) || q.includes("glow"))).toEqual([]);
  });

  it("proposes real competitors, relevant keywords and natural questions", () => {
    const p = plainProposal(glowInput);
    expect(p.competitors.map((c) => c.domain)).toEqual(["bayou-web-studio.example", "riverton-site-builders.example"]);

    // On-topic first, the namesake "glow stick" after, and three brand searches at most, last.
    expect(p.keywords.map((k) => k.keyword)).toEqual(["custom web design riverton", "web design st clair tx", "glow stick", "glowworm", "glowworm web", "glow worm agency"]);
    expect(p.keywords.slice(3).every((k) => k.tag === "brand")).toBe(true);

    expect(p.ideas.slice(0, 3)).toEqual([
      { keyword: "st clair web design agency", volume: null, source: "homepage", tag: expect.anything() },
      { keyword: "web design st clair", volume: null, source: "homepage", tag: expect.anything() },
      { keyword: "web design agency st clair", volume: null, source: "homepage", tag: expect.anything() },
    ]);
    expect(p.ideas.find((k) => k.keyword === "web design riverton")).toMatchObject({ volume: 900, source: "homepage" });
    expect(p.ideas.map((k) => k.keyword)).toContain("website developer baytown");
    expect(p.ideas.map((k) => k.keyword).filter((k) => k.includes("glow"))).toEqual([]);

    expect(p.prompts.map((x) => x.prompt)).toEqual([
      "What's the best web design agency in St. Clair, Ohio?",
      "Who does the best web design in St. Clair, Ohio?",
      "Who does the best web design in Riverton, Ohio?",
      "What's the best web design agency in Riverton, Ohio?",
      "Who does the best web design in Baytown, Ohio?",
      "What's the best web design agency in Baytown, Ohio?",
      "Who does the best custom web design in Riverton, Ohio?",
      "Who is the best website developer in Baytown, Ohio?",
    ]);
  });

  it("doesn't take a town in the name for the brand (Salem Web Design)", () => {
    const site: SiteFacts = {
      title: "Salem Web Design | Web Designers in Salem, NH",
      description: "Websites for Salem businesses.",
      headings: [],
      business: null,
      cities: ["Salem, NH"],
    };
    const b = brandTokens("Salem Web Design", "salemwebdesign.example", site);
    expect(b).not.toContain("salem");
    expect(isBranded("web designer salem", b)).toBe(false);
    expect(isBranded("salem web design company", b)).toBe(true);
    expect(homepageSeeds(site, b)).toEqual(["web designers in salem nh", "web designers salem"]);
  });

  it("leaves a price in the title out of the service (Beta Web Design)", () => {
    const site: SiteFacts = {
      title: "Web Design Salem NH From $400/mo | Beta Web Design",
      description: "Salem web design with the price up front: a small business website for $400 a month or $3,500 one-time.",
      headings: [],
      business: null,
      cities: ["Salem, NH"],
    };
    const b = brandTokens("Beta Web Design", "betaweb.example", site);
    expect(homepageSeeds(site, b)).toEqual(["web design salem nh", "web design salem"]);
    expect(mapsKeywords({ domain: "betaweb.example", projectName: "Beta Web Design", site })).toEqual(["web design Salem, NH"]);
  });

  it.each([
    ["$99 Websites in Riverton, TX", "websites"],
    ["Web Design in Riverton, TX, starting at $1,200", "web design"],
    ["Web Design Riverton TX for $400 a Month", "web design"],
    ["Web Design Riverton TX $3,500 One-Time", "web design"],
    ["Web Design Riverton TX 400/mo", "web design"],
    ["Web Design Riverton TX €49 per month", "web design"],
  ])("finds the service in %s", (title, term) => {
    const site: SiteFacts = { title, description: null, headings: [], business: null, cities: ["Riverton, TX"] };
    expect(mapsKeywords({ domain: "acme.com", projectName: "Acme", site })).toEqual([`${term} Riverton, TX`]);
  });

  it("keeps numbers that aren't prices", () => {
    const site: SiteFacts = { title: "24/7 Plumber Riverton TX", description: null, headings: [], business: null, cities: ["Riverton, TX"] };
    expect(mapsKeywords({ domain: "acme.com", projectName: "Acme", site })).toEqual(["24 7 plumber Riverton, TX"]);
  });
});

/**
 * Client HR (made up): a local HR consultancy's homepage facts, the kind of businesses Google Maps shows for "hr
 * consultant" from each town, and the keyword rows a proposal for it would carry.
 */
describe("a local service business with no structured data (Client HR)", () => {
  const site: SiteFacts = {
    title: "Client HR - Best Human Resources Consultant Services Riverton Bay OH",
    description: "Client HR offers HR consulting in Riverton, St Clair and Fairview for startups, small businesses and non-profits.",
    headings: [],
    business: { name: "Client HR", city: "Riverton, Ohio" },
    cities: ["Riverton, Ohio", "St Clair, Ohio", "Fairview, Ohio"],
    services: ["compliance", "employee handbooks", "hr best practices", "employee relations", "training and development", "recruiting"],
    offer: "hr consulting",
    audiences: ["startups", "small businesses", "non-profits"],
  };
  const hr = (domain: string | null, category = "HR consulting") => ({ domain, category, categories: [] });
  const maps: MapsSearch[] = [
    { keyword: "hr consultant Riverton, Ohio", items: [hr("hr-one.example"), hr("www.hr-two.example"), hr("www.hr-three.example")] },
    {
      keyword: "hr consultant St Clair, Ohio",
      items: [hr("www.hr-four.example"), hr("hr-five.example"), hr("www.recruit-one.example", "Recruiter"), hr(null, "Consultant"), hr("www.tax-one.example", "Tax preparation service"), hr("www.law-one.example", "Law firm")],
    },
    { keyword: "hr consultant Fairview, Ohio", items: [hr("hr-six.example"), hr("hr-seven.example"), hr("www.prints-one.example", "Fingerprinting service")] },
  ];
  const client: SetupInput = {
    ...base,
    domain: "hr-client.example",
    projectName: "Client HR",
    type: "local",
    locationCode: 2840,
    site,
    keywords: [{ keyword: "hr outsourcing riverton", volume: 20 }],
    ideas: [
      { keyword: "human resources consultant careers", volume: 30 },
      { keyword: "human resources consultant courses", volume: 10 },
      { keyword: "human resources reviews", volume: 10 },
      { keyword: "human resources performance review", volume: 50 },
      { keyword: "human resources employee training", volume: 10 },
    ],
    // The national sites the country-wide lookup returned: a local business must not get these.
    competitors: [
      { domain: "ziprecruiter.com", keywords: 900 },
      { domain: "shrm.org", keywords: 800 },
    ],
    maps,
  };
  const proposal = plainProposal(client);

  it("searches Google Maps for its service in its main towns", () => {
    expect(mapsKeywords(client)).toEqual(maps.map((m) => m.keyword));
  });

  it("proposes the businesses on Google Maps, town by town, not national sites or other trades", () => {
    expect(proposal.competitors.map((c) => c.domain)).toEqual(["hr-one.example", "hr-four.example", "hr-six.example", "hr-two.example", "hr-five.example"]);
    expect(proposal.competitors[1].reason).toBe("#1 on Google Maps for “hr consultant St Clair, Ohio”");
  });

  it("ideas are its services in its towns, without careers, courses or reviews", () => {
    const ideas = proposal.ideas.map((k) => k.keyword);
    expect(ideas).toEqual(expect.arrayContaining(["hr consultant riverton", "hr consulting st clair", "hr consultant fairview"]));
    expect(ideas.filter((k) => /careers|courses|reviews|performance/.test(k))).toEqual([]);
    expect(proposal.ideas.filter((k) => k.source === "homepage").length).toBeGreaterThan(3);
  });

  it("keeps only Google's ideas that name its towns or say near me, and says so", () => {
    // Ideas of the kind Google gives a local consultancy, plus two local ones.
    const live = [
      "human services vs human resources",
      "human resources shared services",
      "human resources support services",
      "human resources advisory services",
      "human resources and services",
      "becoming a human resources consultant",
      "human resources and payroll services",
      "human resources management and services",
      "human resources services private limited",
      "best human resources consultancy",
      "human resources outsourcing riverton",
      "human resources consultant near me",
    ].map((keyword) => ({ keyword, volume: 10 }));
    const p = plainProposal({ ...client, ideas: live });
    const google = p.ideas.filter((k) => k.source !== "homepage").map((k) => k.keyword);
    expect(google).toEqual(["human resources outsourcing riverton", "human resources consultant near me"]);
    expect(p.notes).toContain("Left out 10 keyword ideas from Google that don't name your towns.");
  });

  it("carries the business name Google Maps gave a competitor, and none when it gave none", () => {
    const named = plainProposal({ ...client, maps: [{ keyword: "hr consultant Riverton, Ohio", items: [{ ...hr("hr-one.example"), title: " HR One " }, hr("www.hr-three.example")] }] });
    expect(named.competitors.find((c) => c.domain === "hr-one.example")?.name).toBe("HR One");
    expect(named.competitors.find((c) => c.domain === "hr-three.example")).not.toHaveProperty("name");
  });

  it("drops a Maps title too long for Apply to accept, so it can't fail the whole selection", () => {
    const title = "x".repeat(MAX_COMPETITOR_NAME + 1);
    const p = plainProposal({ ...client, maps: [{ keyword: "hr consultant Riverton, Ohio", items: [{ ...hr("hr-one.example"), title }] }] });
    expect(p.competitors.find((c) => c.domain === "hr-one.example")).not.toHaveProperty("name");
  });

  it("words the note for one off-topic ranked keyword and for several", () => {
    const off = (keywords: string[]) => plainProposal({ ...client, keywords: keywords.map((keyword) => ({ keyword, volume: 10 })) }).notes;
    expect(off(["celebrity birthdays"])).toContain("Left out 1 keyword you rank for that isn't about your services or towns.");
    expect(off(["celebrity birthdays", "banana bread"])).toContain("Left out 2 keywords you rank for that aren't about your services or towns.");
  });

  it("counts ranked keywords that are already tracked, so an empty list isn't read as ranking for none", () => {
    const p = plainProposal({ ...client, existing: { ...client.existing, keywords: ["hr outsourcing riverton"] } });
    expect(p.keywords).toEqual([]);
    expect(p.rankedKeywords).toBe(1);
    expect(plainProposal({ ...client, keywords: [] }).rankedKeywords).toBe(0);
  });

  it("doesn't count an idea dropped for another reason as naming no town", () => {
    const p = plainProposal({ ...client, ideas: [{ keyword: "human resources jobs riverton", volume: 10 }] });
    expect(p.ideas.map((k) => k.keyword)).not.toContain("human resources jobs riverton");
    expect(p.notes.join(" ")).not.toContain("name your towns");
  });

  it("still tracks a ranked keyword about its services without a town", () => {
    const p = plainProposal({ ...client, keywords: [{ keyword: "human resources consultant", volume: 90 }] });
    expect(p.keywords.map((k) => k.keyword)).toEqual(["human resources consultant"]);
  });

  it("asks who to hire in each town, varied, using its services and audiences", () => {
    const asked = proposal.prompts.map((p) => p.prompt);
    expect(asked).toEqual(expect.arrayContaining(["Who is the best HR consultant in Riverton, Ohio?", "Who is the best HR consultant in St Clair, Ohio?", "Who is the best HR consultant in Fairview, Ohio?"]));
    expect(asked.some((p) => /^Who helps (startups|small businesses|non-profits) with .+ in .+, Ohio\?$/.test(p))).toBe(true);
    expect(asked.every((p) => /Ohio\?$/.test(p))).toBe(true);
    expect(new Set(asked).size).toBe(asked.length);
  });

  it("offers the Maps listing step, and says when Maps had nothing or a town couldn't be searched", () => {
    expect(proposal.local).toEqual({ name: "Client HR", city: "Riverton, Ohio" });
    const empty = plainProposal({ ...client, maps: [], unknownTowns: ["St Hed"] });
    expect(empty.competitors).toEqual([]);
    expect(empty.notes.join(" ")).toContain("Google Maps showed no businesses");
    expect(empty.notes.join(" ")).toContain("St Hed");
  });
});

describe("a business that isn't local", () => {
  const site: SiteFacts = {
    title: "Acme CRM: simple CRM software for small teams",
    description: "CRM software for sales teams.",
    headings: ["Pipeline tracking"],
    business: null,
    cities: [],
  };
  const saas: SetupInput = {
    ...base,
    domain: "acmecrm.example",
    projectName: "Acme CRM",
    type: "software",
    locationCode: 2840,
    site,
    keywords: [{ keyword: "crm software for small business", volume: 900 }],
    competitors: [
      { domain: "hubspot.com", keywords: 400 },
      { domain: "pipedrive.com", keywords: 300 },
    ],
  };

  it("keeps Google's ideas that name no town", () => {
    const p = plainProposal({ ...saas, ideas: [{ keyword: "crm software pricing", volume: 50 }] });
    expect(p.ideas.map((k) => k.keyword)).toContain("crm software pricing");
    expect(p.notes.join(" ")).not.toContain("name your towns");
  });

  it("software keeps Google's competitors, needs no Maps search, and asks about alternatives", () => {
    const p = plainProposal(saas);
    expect(mapsKeywords(saas)).toEqual([]);
    expect(p.competitors.map((c) => c.domain)).toEqual(["hubspot.com", "pipedrive.com"]);
    expect(p.local ?? null).toBeNull();
    expect(p.prompts.some((q) => /alternatives to Hubspot/i.test(q.prompt))).toBe(true);
    expect(p.prompts.some((q) => /Who is the best/.test(q.prompt) && /in .+, /.test(q.prompt))).toBe(false);
  });

  it("a store asks where to buy", () => {
    const p = plainProposal({ ...saas, domain: "acmeboots.example", projectName: "Acme Boots", type: "store", competitors: [], keywords: [{ keyword: "leather work boots", volume: 500 }], site: { ...site, title: "Leather work boots", description: "Work boots shipped free." } });
    expect(p.prompts.map((q) => q.prompt).join(" ")).toMatch(/buy|best/i);
  });
});

describe("a business that isn't local, named by its searches", () => {
  // A made-up Basecamp report product, Reportwell: a homepage title and description, and search rows shaped like
  // what Google reports for "basecamp report". The volumes on the junk rows are placeholders.
  const site: SiteFacts = {
    title: "Daily Basecamp reports with a note of every change · Reportwell",
    description: "Reportwell reads your Basecamp projects every night and emails you a summary of what changed.",
    headings: [],
    business: null,
    cities: [],
  };
  const known = [
    { keyword: "basecamp report", volume: 50 },
    { keyword: "how to report basecamp", volume: 10 },
    { keyword: "report basecamp project", volume: 10 },
    { keyword: "basecamp local report", volume: 10 },
    { keyword: "basecamp automatic report", volume: 10 },
  ];
  const input: SetupInput = {
    ...base,
    domain: "reportwell.app",
    projectName: "Reportwell",
    type: "software",
    site,
    searches: [
      { keyword: "basecamp report", ideas: known },
      { keyword: "basecamp change history", ideas: [] },
    ],
  };

  it("guesses the searches from the title and the guides on the same subject", () => {
    const guess = suggestedSearches({
      site,
      domain: "reportwell.app",
      projectName: "Reportwell",
      type: "software",
      // In the order the homepage links them.
      topics: ["recover deleted basecamp messages", "how to report on basecamp", "basecamp change history", "basecamp snapshots", "undo bulk edit basecamp", "restore basecamp from csv", "export entire basecamp project"],
    });
    expect(guess).toEqual(["basecamp report", "basecamp snapshots", "basecamp change history"]);
  });

  it("keeps a store's plural, the form products are searched by", () => {
    const shoes = { ...site, title: "Running shoes for every distance · Acme" };
    expect(suggestedSearches({ site: shoes, domain: "acme.com", projectName: "Acme", type: "store" })).toEqual(["running shoes"]);
  });

  it("guesses nothing from a one-word title or a brand", () => {
    expect(suggestedSearches({ site: { ...site, title: "Reports · Reportwell", description: null }, domain: "reportwell.app", projectName: "Reportwell", type: "software" })).toEqual([]);
  });

  it("requires the product the business is built on in Google's ideas, and in its searches for competitors", () => {
    const p = plainProposal({
      ...input,
      ideas: [
        { keyword: "jira report", volume: 1000 },
        { keyword: "asana report", volume: 1000 },
        { keyword: "basecamp export", volume: 100 },
      ],
    });
    const ideas = p.ideas.map((k) => k.keyword);
    expect(ideas).toContain("basecamp export");
    expect(ideas).not.toContain("jira report");
    expect(ideas).not.toContain("asana report");
    expect(competitorQueries({ ...input, ideas: [{ keyword: "jira report", volume: 1000 }] })).not.toContain("jira report");
  });

  it("leaves a business not built on another product to the homepage's vocabulary", () => {
    const p = plainProposal({
      ...base,
      domain: "acme.com",
      projectName: "Acme",
      type: "software",
      site: { ...site, title: "Email marketing software · Acme", description: "Send better email newsletters." },
      searches: [{ keyword: "email marketing software", ideas: [{ keyword: "email marketing software", volume: 5000 }] }],
      ideas: [{ keyword: "email newsletter tool", volume: 900 }],
    });
    expect(p.ideas.map((k) => k.keyword)).toContain("email newsletter tool");
  });

  it("starts the searches Google knows ticked, and leaves one it doesn't unticked with a note", () => {
    const p = plainProposal(input);
    expect(p.ideas.find((k) => k.keyword === "basecamp report")).toMatchObject({ volume: 50, source: "search" });
    expect(p.ideas.find((k) => k.keyword === "how to report basecamp")).toMatchObject({ volume: 10, source: "search" });
    expect(p.ideas.find((k) => k.keyword === "basecamp change history")).toMatchObject({ volume: null, source: "unknown" });
    expect(p.notes.join(" ")).toContain("Google has no data for “basecamp change history”, so it didn't shape this proposal and starts unticked.");
    expect(p.prompts.map((q) => q.keyword)).not.toContain("basecamp change history");
  });

  it("doesn't let a search Google doesn't know decide what's on topic", () => {
    const p = plainProposal({
      ...input,
      searches: [{ keyword: "ship faster", ideas: [] }],
      ideas: [{ keyword: "basecamp export", volume: 100 }],
    });
    expect(p.ideas.map((k) => k.keyword)).toContain("basecamp export");
  });

  it("names several searches Google doesn't know in a sentence", () => {
    const p = plainProposal({ ...input, searches: [...input.searches!, { keyword: "basecamp snapshots", ideas: [] }] });
    expect(p.notes.join(" ")).toContain("“basecamp change history” and “basecamp snapshots”, so they didn't shape this proposal and start unticked.");
  });

  it("says when a market is small, with what Google reported", () => {
    expect(plainProposal(input).notes.join(" ")).toContain("small market: Google reports about 90 searches a month across the 5 keywords");
    const big = { ...input, searches: [{ keyword: "basecamp report", ideas: [{ keyword: "basecamp report", volume: 4000 }] }] };
    expect(plainProposal(big).notes.join(" ")).not.toContain("small market");
  });

  it("puts the sites its own comparison page names first, then Google's", () => {
    const p = plainProposal({
      ...input,
      comparedSites: ["www.madeup-reports.com", "thetareport.example"],
      competitors: [
        { domain: "madeup-reports.com", keywords: 1 },
        { domain: "blog.syncpail.io", keywords: 1 },
      ],
    });
    expect(p.competitors).toEqual([
      { domain: "madeup-reports.com", reason: "Named on your comparison page" },
      { domain: "thetareport.example", reason: "Named on your comparison page" },
      { domain: "blog.syncpail.io", reason: expect.stringContaining("Ranks in Google") },
    ]);
  });

  it("leaves out the product it's built on and forums about it", () => {
    const p = plainProposal({
      ...input,
      competitors: ["community.basecamp.com", "basecamp.com", "base.campforums.example", "support.example.com", "madeup-reports.com"].map((domain) => ({ domain, keywords: 1 })),
    });
    expect(p.competitors.map((c) => c.domain)).toEqual(["madeup-reports.com"]);
  });

  it("asks about the searches first, with the product's capital, and names a rival by its site, not its subdomain", () => {
    const p = plainProposal({ ...input, comparedSites: ["blog.syncpail.io"] });
    const prompts = p.prompts.map((q) => q.prompt);
    expect(prompts).toContain("What is the best Basecamp report?");
    expect(prompts).toContain("How do I report Basecamp?");
    expect(prompts).toContain("What are the best alternatives to Syncpail?");
  });

  it("makes one question of keywords that reword one another, in the form that reads best", () => {
    // Shaped like what Google reports for searches like these; the volumes are placeholders.
    const live = [
      { keyword: "basecamp report", volume: 50 },
      { keyword: "basecamp snapshots", volume: 30 },
      { keyword: "how to report basecamp", volume: 10 },
      { keyword: "report basecamp project", volume: 10 },
      { keyword: "basecamp local report", volume: 10 },
      { keyword: "report basecamp", volume: 10 },
      { keyword: "basecamp report project", volume: 10 },
      { keyword: "basecamp automatic report", volume: 10 },
    ];
    const p = plainProposal({
      ...input,
      searches: [
        { keyword: "basecamp report", ideas: live.filter((k) => k.keyword !== "basecamp snapshots") },
        { keyword: "basecamp snapshots", ideas: live.filter((k) => k.keyword === "basecamp snapshots") },
        { keyword: "basecamp change history", ideas: [] },
      ],
      comparedSites: ["madeup-reports.com", "thetareport.example"],
    });
    expect(p.prompts.map((q) => q.prompt)).toEqual([
      "What is the best Basecamp report?",
      "What are the best Basecamp snapshots?",
      "How do I report Basecamp?",
      "What is the best Basecamp local report?",
      "What is the best Basecamp report project?",
      "What is the best Basecamp automatic report?",
      "What are the best alternatives to Madeup-reports?",
      "What are the best alternatives to Thetareport?",
    ]);
  });

  it("keeps keywords apart that differ only by a number", () => {
    const p = plainProposal({ ...input, searches: [], keywords: [{ keyword: "basecamp api 2", volume: 20 }, { keyword: "basecamp api 3", volume: 10 }, { keyword: "2 api basecamp", volume: 5 }], site: null });
    expect(p.prompts.map((q) => q.keyword)).toEqual(["basecamp api 2", "basecamp api 3"]);
  });

  it("only blames Google for no competitors when it asked Google", () => {
    const none = plainProposal({ ...base, type: "software", site: null });
    expect(none.notes.join(" ")).toContain("No searches to check for competitors yet");
    expect(none.notes.join(" ")).not.toContain("Google's results");
    expect(plainProposal(input).notes.join(" ")).toContain("Google's results for these searches showed no other businesses");
  });

  it("checks the searches and their keywords for competitors before what the site ranks for", () => {
    const queries = competitorQueries({ ...input, keywords: [{ keyword: "basecamp export", volume: 500 }] });
    expect(queries.slice(0, 2)).toEqual(["basecamp report", "basecamp change history"]);
    expect(queries.indexOf("how to report basecamp")).toBeLessThan(queries.indexOf("basecamp export"));
  });

  it("changes nothing for a local business", () => {
    const local = { ...base, type: "local" as const, site: null };
    expect(plainProposal(local)).toEqual(plainProposal({ ...local, searches: [], comparedSites: [] }));
  });
});
