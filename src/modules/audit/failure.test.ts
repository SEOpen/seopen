import { describe, expect, it, vi } from "vitest";
import { creditsRefusal, PLATFORM_REFUSAL } from "@/lib/billing/spend";
import { CRAWL_CANCELLED } from "@/lib/dataforseo/failure-copy";
import { auditFailure, crawlFix } from "./failure";
import { rules } from "@/plan-policy/rules";

vi.mock("server-only", () => ({}));

const at = new Date("2026-11-07T10:00:00Z");
const crawl = (error: string | null, status = "failed") => ({ status, error, createdAt: at });

describe("auditFailure", () => {
  it("sends a rejected domain to Project settings, because crawling again won't help", () => {
    const f = auditFailure(crawl("40501 Invalid Field"), 9, "UTC");
    expect(f).toMatchObject({ noun: "crawl", retry: false, next: { label: "Open Project settings", href: "/projects/9/settings" } });
    expect(f?.reason).toMatch(/Check the project's domain/);
    expect(crawlFix("40501 Invalid Field", 9)?.href).toBe("/projects/9/settings");
  });

  it.skipIf(!rules.hasPlans)("sends a refusal to Billing and offers no link for a problem on the service's side", () => {
    expect(crawlFix(creditsRefusal({ plan: "starter" }, 10).message, 9)?.href).toBe("/billing");
    expect(crawlFix(PLATFORM_REFUSAL.message, 9)).toBeNull();
    expect(crawlFix("50000 Internal Error.", 9)).toBeNull();
    expect(crawlFix(null, 9)).toBeNull();
  });

  it("doesn't call a crawl the customer stopped a failure", () => {
    expect(auditFailure(crawl(CRAWL_CANCELLED), 9, "UTC")).toBeNull();
  });

  it("gives Overview a plain line for a crawl that stopped, never the service's status", () => {
    const f = auditFailure(crawl("The crawl stopped: terminated by server"), 9, "UTC");
    expect(f?.reason).toBe("The crawl stopped before it reached any pages.");
  });

  it("is nothing while crawling, queued or done", () => {
    for (const status of ["queued", "posting", "crawling", "importing", "done"]) expect(auditFailure(crawl(null, status), 9, "UTC")).toBeNull();
    expect(auditFailure(undefined, 9, "UTC")).toBeNull();
  });
});
