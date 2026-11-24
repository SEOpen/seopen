import { beforeEach, describe, expect, it, vi } from "vitest";
import { GoogleNotConnectedError } from "./types";

const googleApis = vi.hoisted(() => vi.fn());
vi.mock("./apis", () => ({ googleApis }));

const { forgetGoogleProperties, googleChoices } = await import("./properties");

const WORKSPACE = 1;

beforeEach(() => {
  googleApis.mockReset();
  forgetGoogleProperties(WORKSPACE);
});

describe("googleChoices", () => {
  it("gives the account's properties, leaving out sites Search Console won't answer for", async () => {
    const ga4 = [{ property: "properties/1", propertyName: "Site", account: "accounts/1", accountName: "Me", streamDomains: [] }];
    googleApis.mockResolvedValue({
      mode: "live",
      gsc: {
        sites: async () => [
          { siteUrl: "sc-domain:a.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://b.com/", permissionLevel: "siteUnverifiedUser" },
        ],
      },
      ga4: { properties: async () => ga4 },
    });
    expect(await googleChoices(WORKSPACE)).toEqual({ state: "connected", sites: [{ siteUrl: "sc-domain:a.com", permissionLevel: "siteOwner" }], ga4 });
  });

  it("offers to connect an account that has none, or has lost access", async () => {
    googleApis.mockRejectedValueOnce(new GoogleNotConnectedError("not_connected"));
    expect(await googleChoices(WORKSPACE)).toEqual({ state: "connect" });
    googleApis.mockRejectedValueOnce(new GoogleNotConnectedError("reauth_required"));
    expect(await googleChoices(WORKSPACE)).toEqual({ state: "connect" });
  });

  it("says nothing when there is nothing to connect to", async () => {
    googleApis.mockRejectedValue(new GoogleNotConnectedError("not_configured"));
    expect(await googleChoices(WORKSPACE)).toEqual({ state: "hidden" });
  });

  it("never rejects when Google fails, so the form still works", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    googleApis.mockResolvedValue({ mode: "live", gsc: { sites: () => Promise.reject(new Error("503")) }, ga4: { properties: async () => [] } });
    expect(await googleChoices(WORKSPACE)).toEqual({ state: "hidden" });
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});
