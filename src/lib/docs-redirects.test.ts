import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { docsRedirects, HOSTED_DOCS_ORIGIN } from "./docs-redirects";

describe("docsRedirects", () => {
  const dirs: string[] = [];
  const root = () => {
    const dir = mkdtempSync(path.join(tmpdir(), "seopen-docs-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("sends /docs to the hosted docs on a copy without the docs route", () => {
    expect(docsRedirects(root())).toEqual([
      { source: "/docs", destination: `${HOSTED_DOCS_ORIGIN}/docs`, permanent: false },
      { source: "/docs/:path*", destination: `${HOSTED_DOCS_ORIGIN}/docs/:path*`, permanent: false },
    ]);
  });

  it("adds nothing where the docs route exists", () => {
    const dir = root();
    mkdirSync(path.join(dir, "src/app/(site)/docs"), { recursive: true });
    expect(docsRedirects(dir)).toEqual([]);
  });
});
