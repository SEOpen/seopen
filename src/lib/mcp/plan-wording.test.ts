import { describe, expect, it } from "vitest";
import { plainRefusal } from "./plan-wording";

describe("plainRefusal", () => {
  it.each([
    ["This isn't part of the Free plan, which covers a weekly site audit. Choose a plan on the Billing page to use it.", "This isn't part of the Free plan, which covers a weekly site audit."],
    ["This workspace has no active plan, so paid checks are off. Choose a plan on the Billing page; your data is kept.", "This workspace has no active plan, so paid checks are off. Your data is kept."],
    ["Choose a plan on the Billing page. Paid checks start then.", "This isn't part of this workspace's plan."],
    ["The card was declined. Upgrade now to start your plan; paid checks resume as soon as the first payment goes through.", "The card was declined."],
    ["Your trial's allowance is used up. Upgrade now to keep going with your plan's full limits.", "Your trial's allowance is used up."],
    [
      "This run needs about 40 research credits and 3 are left. Upgrade now for your plan's full monthly credits; the Monday run still asks every prompt.",
      "This run needs about 40 research credits and 3 are left. The Monday run still asks every prompt.",
    ],
    ["This project is read-only: your plan has fewer projects than this workspace holds. Upgrade, or archive another project, to edit and check it again.", "This project is read-only: your plan has fewer projects than this workspace holds. Archive another project to edit and check it again."],
    [
      "The Free plan includes one site audit a week, and this week's has been used. The next can start on Monday, or choose a plan on the Billing page to audit more often.",
      "The Free plan includes one site audit a week, and this week's has been used. The next can start on Monday.",
    ],
    [
      "Another Free workspace already has site.example, and a site can be on the Free plan in one workspace at a time. Upgrade to add it here, or ask the owner of that workspace to archive it there.",
      "Another Free workspace already has site.example, and a site can be on the Free plan in one workspace at a time. Ask the owner of that workspace to archive it there.",
    ],
  ])("%s", (from, to) => expect(plainRefusal(from)).toBe(to));

  it.each([
    "Your plan allows 2 projects, and they're all in use.",
    "All 500 research credits for this month are used. They reset on the 1st; tracking, audits and the weekly AI checks keep running.",
    "No project “upgrade.example” in this workspace. Call list_projects to see them.",
    "upgrade.example is already project 3 in this workspace.",
    "Can't restore Upgrade Depot: Your plan tracks 50 keywords, and they're all in use.",
  ])("leaves text without an offer alone: %s", (text) => expect(plainRefusal(text)).toBe(text));
});
