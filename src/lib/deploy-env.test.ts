import { describe, expect, it } from "vitest";
import { isProductionDeploy } from "./deploy-env";

describe("isProductionDeploy", () => {
  it("is true for Vercel production or SEOPEN_DEPLOY_ENV=production", () => {
    expect(isProductionDeploy({ VERCEL_ENV: "production" })).toBe(true);
    expect(isProductionDeploy({ SEOPEN_DEPLOY_ENV: "production" })).toBe(true);
  });

  it("is false everywhere else, including near misses", () => {
    expect(isProductionDeploy({})).toBe(false);
    expect(isProductionDeploy({ VERCEL_ENV: "preview" })).toBe(false);
    expect(isProductionDeploy({ VERCEL: "1" })).toBe(false);
    expect(isProductionDeploy({ NODE_ENV: "production" })).toBe(false);
    for (const value of ["", "Production", "prod", " production"]) expect(isProductionDeploy({ SEOPEN_DEPLOY_ENV: value })).toBe(false);
  });

  it("lets VERCEL_ENV decide whenever it's set, so the flag can't promote a Vercel preview", () => {
    expect(isProductionDeploy({ VERCEL_ENV: "preview", SEOPEN_DEPLOY_ENV: "production" })).toBe(false);
    expect(isProductionDeploy({ VERCEL_ENV: "development", SEOPEN_DEPLOY_ENV: "production" })).toBe(false);
    expect(isProductionDeploy({ VERCEL_ENV: "", SEOPEN_DEPLOY_ENV: "production" })).toBe(false);
    expect(isProductionDeploy({ VERCEL_ENV: "production", SEOPEN_DEPLOY_ENV: "preview" })).toBe(true);
  });
});
