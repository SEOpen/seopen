import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const forced = vi.hoisted(() => ({ state: "idle", action: { error: "Nope." } as unknown }));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    // The state an error shows in, which only a submit reaches in a browser.
    useState: (initial: unknown) => (initial === "idle" ? [forced.state, () => {}] : react.useState(initial)),
    useActionState: () => [forced.action, () => {}, false],
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }) }));
vi.mock("@/lib/auth/client", () => ({ authClient: {} }));
vi.mock("@/modules/keywords/actions", () => ({ renameList: vi.fn() }));
vi.mock("@/modules/local/actions", () => ({ addBusiness: vi.fn(), addKeywords: vi.fn(), checkNow: vi.fn(), findListings: vi.fn(), removeBusiness: vi.fn(), updateBusiness: vi.fn() }));
// Upgrade now posts to a billing action that only loads on the server.
vi.mock("@/components/plan-upgrade", () => ({ UpgradeNow: () => null }));

const { ResetPasswordForm } = await import("./auth/reset-password-form");
const { ForgotPasswordForm } = await import("./auth/forgot-password-form");
const { ChangePasswordForm } = await import("./settings/change-password-form");
const { SignOutElsewhereForm } = await import("./settings/sign-out-elsewhere-form");
const { RenameList } = await import("@/modules/keywords/components/rename-list");
const { AddKeywordsForm } = await import("@/modules/local/components/forms");

const alertSays = (html: string, words: string) => {
  const at = html.indexOf('role="alert"');
  expect(at).toBeGreaterThan(-1);
  expect(html.slice(at).replace(/&#x27;/g, "'")).toContain(words);
};

// An error that appears after the user acts is announced to screen readers.
describe("errors that appear after a submit", () => {
  beforeEach(() => {
    forced.state = "idle";
  });

  it("announce on the password forms", () => {
    forced.state = "mismatch";
    alertSays(renderToStaticMarkup(<ResetPasswordForm token="t" />), "The two passwords don't match.");
    forced.state = "failed";
    alertSays(renderToStaticMarkup(<ResetPasswordForm token="t" />), "That link has expired or was already used.");
    forced.state = "limited";
    alertSays(renderToStaticMarkup(<ForgotPasswordForm />), "Too many requests.");
    forced.state = "wrong";
    alertSays(renderToStaticMarkup(<ChangePasswordForm email="a@example.com" />), "That's not your current password.");
  });

  it("announce on the small forms", () => {
    alertSays(renderToStaticMarkup(<RenameList listId={1} name="A list" />), "Nope.");
    alertSays(renderToStaticMarkup(<SignOutElsewhereForm />), "Nope.");
    alertSays(renderToStaticMarkup(<AddKeywordsForm projectId={1} businessId={1} />), "Nope.");
  });

  // Held in state several hooks deep, so these read the element itself.
  it.each([
    ["src/modules/ai/components/add-prompts.tsx", /<Callout tone="bad" role="alert">\s*<RefusalText text=\{error\} \/>/],
    ["src/modules/google/ui/import-picker.tsx", /role=\{state\.ok \? undefined : "alert"\}/],
    ["src/components/city-picker.tsx", /<p role="alert"[^>]*>\s*\{found\.error\}/],
  ])("announce in %s", (file, element) => {
    expect(readFileSync(file, "utf8")).toMatch(element);
  });
});
