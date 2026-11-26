import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

/** One service's block of compose.yaml: from its two-space-indented name to the next one. */
function service(compose: string, name: string): string {
  const start = compose.indexOf(`\n  ${name}:\n`);
  if (start < 0) return "";
  const rest = compose.slice(start + name.length + 4);
  const next = rest.search(/\n {2}[a-z][\w-]*:\n|\n[a-z]/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe("compose.yaml and docs/self-hosting.md", () => {
  it("apply migrations the way the docs say", () => {
    const compose = read("compose.yaml");
    expect(service(compose, "migrate")).toMatch(/command: \["node", "--import", "tsx", "scripts\/migrate.ts"\]/);
    for (const name of ["web", "worker"]) expect(service(compose, name)).toMatch(/migrate:\s+condition: service_completed_successfully/);

    const docs = read("docs/self-hosting.md");
    // The docs once said compose sets MIGRATE_ON_START; it runs the migrate service instead.
    if (!compose.includes("MIGRATE_ON_START")) expect(docs).not.toMatch(/compose file sets it/);
    expect(docs).toMatch(/`migrate` service runs `scripts\/migrate.ts`/);
  });

  it("runs the worker under Node itself, so `docker compose stop` reaches its shutdown handler", () => {
    // Under pnpm and the tsx CLI the stop signal never reached src/worker.ts: no "[worker] stopping",
    // and pnpm logged "ELIFECYCLE Command failed".
    expect(service(read("compose.yaml"), "worker")).toMatch(/command: \["node", "--import", "tsx", "src\/worker.ts"\]/);
  });
});
