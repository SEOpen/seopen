import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryButton, withoutRun } from "./retry-button";

const router = { refresh: vi.fn(), replace: vi.fn() };
let pending = false;
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useTransition: () => [pending, (fn: () => void) => fn()],
}));

type ButtonProps = { onClick: () => void; disabled: boolean; "aria-busy": boolean };
const button = () => (RetryButton({}) as ReactElement<ButtonProps>).props;
const at = (href: string) => vi.stubGlobal("window", { location: { href } });

describe("withoutRun", () => {
  it("drops run and keeps everything else", () => {
    expect(withoutRun("https://app.test/backlinks?q=a.com&run=1&loc=2840#top")).toBe("/backlinks?q=a.com&loc=2840#top");
  });

  it("leaves no empty query behind", () => {
    expect(withoutRun("https://app.test/backlinks?run=1")).toBe("/backlinks");
  });

  it("is null without a run param", () => {
    expect(withoutRun("https://app.test/backlinks?q=a.com")).toBeNull();
    expect(withoutRun("https://app.test/rerun?runs=1")).toBeNull();
  });
});

describe("RetryButton", () => {
  beforeEach(() => {
    pending = false;
    router.refresh.mockReset();
    router.replace.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("goes back to the priced prompt from an address that would spend", () => {
    at("https://app.test/backlinks?q=a.com&run=1");
    button().onClick();
    expect(router.replace).toHaveBeenCalledWith("/backlinks?q=a.com");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("re-renders any other address", () => {
    at("https://app.test/gsc/sitemaps?period=28d");
    button().onClick();
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("is disabled while the retry is pending", () => {
    expect(button().disabled).toBe(false);
    pending = true;
    expect(button().disabled).toBe(true);
    expect(button()["aria-busy"]).toBe(true);
  });
});
