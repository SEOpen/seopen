/**
 * Runs a script if this copy of SEOpen has it, and skips it with a note if not. package.json's
 * optional steps go through this, so a copy that lacks one of their scripts still builds from the
 * same package.json:
 *
 *   tsx scripts/run-if-present.ts scripts/content/build.ts [args...]
 *
 * The script runs in this process, with process.argv set as if tsx had started it directly, so its
 * own arguments and its "am I the entry point" check work as before.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("Usage: tsx scripts/run-if-present.ts <script> [args...]");
  process.exit(2);
}
const target = path.resolve(file);
if (!existsSync(target)) {
  console.log(`${file} isn't in this copy of SEOpen, so this step is skipped.`);
} else {
  process.argv = [process.argv[0], target, ...rest];
  // Not a top-level await: tsx compiles these scripts as CommonJS, which has none.
  import(pathToFileURL(target).href).catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
