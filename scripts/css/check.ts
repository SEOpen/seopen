/**
 * `pnpm css:check`: runs after `next build`, inside `pnpm build`, so an error stops the deploy.
 * Every colour token in src/app/globals.css must appear with the same value in the built stylesheet.
 * A restored build cache once shipped old tokens under a new filename: the build passed and every
 * page responded, with an invisible main button. The cure is a rebuild with the cache off.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SOURCE = path.join(ROOT, "src/app/globals.css");
const BUILT = path.join(ROOT, ".next/static");

/** The minifier may shorten a hex colour, so #FFFFFF, #ffffff and #fff compare equal. */
function normalize(hex: string): string {
  const h = hex.toLowerCase();
  return /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/.test(h) ? `#${h[1]}${h[3]}${h[5]}` : h;
}

/** Every `--name: #hex` declaration, once per name and value: a token has one value per theme. */
function colourTokens(css: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of css.matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*[;}]/g)) tokens.add(`${m[1]}: ${normalize(m[2])}`);
  return tokens;
}

/** The source's colour tokens that the built stylesheet doesn't have. */
export function staleTokens(source: string, built: string): string[] {
  const shipped = colourTokens(built);
  return [...colourTokens(source)].filter((t) => !shipped.has(t));
}

function builtCss(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return builtCss(full);
      return name.endsWith(".css") ? readFileSync(full, "utf8") : "";
    })
    .join("\n");
}

function main() {
  const source = readFileSync(SOURCE, "utf8");
  const built = builtCss(BUILT);
  const total = colourTokens(source).size;
  if (!total) {
    console.error("css:check failed: no colour tokens found in src/app/globals.css");
    process.exit(1);
  }
  if (!built) {
    console.error("css:check failed: no stylesheet under .next/static. Run next build first.");
    process.exit(1);
  }
  const stale = staleTokens(source, built);
  if (stale.length) {
    for (const t of stale) console.error(`error: built stylesheet is missing ${t}`);
    console.error(`css:check failed: ${stale.length} of ${total} colour tokens don't match src/app/globals.css.`);
    console.error("A stale build cache is the likely cause: rebuild with the cache off (Redeploy, untick Use existing Build Cache).");
    process.exit(1);
  }
  console.log(`css:check passed: ${total} colour tokens match`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
