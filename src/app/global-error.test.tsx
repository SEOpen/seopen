import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./fonts", () => ({ fontVariables: "" }));
vi.mock("./globals.css", () => ({}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useLayoutEffect: () => {},
}));
// The screen's own parts don't matter here, only what its button does.
vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/brand/wordmark", () => ({ Wordmark: () => null }));
vi.mock("@/lib/theme", () => ({ applySavedTheme: () => {} }));

const { default: GlobalError } = await import("./global-error");
const { Button } = await import("@/components/ui/button");

type ButtonProps = { onClick: () => void };
function findButton(node: ReactNode): ReactElement<ButtonProps> | null {
  if (Array.isArray(node)) return node.map(findButton).find(Boolean) ?? null;
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.type === Button) return node as ReactElement<ButtonProps>;
  return findButton(node.props.children);
}

function tryAgain(href: string) {
  const replace = vi.fn();
  vi.stubGlobal("window", { location: { href, replace } });
  const retry = vi.fn();
  findButton(GlobalError({ error: new Error("x"), retry }))!.props.onClick();
  return { replace, retry };
}

describe("GlobalError's Try again", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reloads without ?run=1, so it can't spend again", () => {
    const { replace, retry } = tryAgain("https://app.test/keywords?q=shoes&run=1");
    expect(replace).toHaveBeenCalledWith("/keywords?q=shoes");
    expect(retry).not.toHaveBeenCalled();
  });

  it("just retries any other address", () => {
    const { replace, retry } = tryAgain("https://app.test/keywords?q=shoes");
    expect(retry).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
