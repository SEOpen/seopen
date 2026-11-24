import { describe, expect, it } from "vitest";
import { offSiteReason } from "./domain";

describe("offSiteReason", () => {
  it("says why when a redirect left the project's domain", () => {
    expect(offSiteReason({ url: "https://team.cloudflareaccess.com/cdn-cgi/access/login/shop.example", redirects: ["https://shop.example/a"] }, "shop.example")).toBe("The page redirects to team.cloudflareaccess.com, which isn't on shop.example, so SEOpen can't read it. A sign-in or access gate in front of the site does this.");
  });

  it("lets redirects on the site through: www, a subdomain, another path", () => {
    for (const url of ["https://www.shop.example/a", "https://blog.shop.example/a", "https://shop.example/b/"]) expect(offSiteReason({ url, redirects: ["https://shop.example/a"] }, "shop.example")).toBeNull();
  });

  it("only judges a fetch that redirected", () => {
    expect(offSiteReason({ url: "", redirects: [] }, "shop.example")).toBeNull();
    expect(offSiteReason({ url: "" }, "shop.example")).toBeNull();
  });
});
