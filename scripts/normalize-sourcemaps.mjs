/**
 * Make the published source maps say the same thing whoever built them.
 *
 * esbuild writes each `sources` entry as a path relative to the output file, and it
 * resolves dependencies through the real filesystem — so on a checkout whose
 * `node_modules` is a symlink (a monorepo, a worktree, a pnpm store) every bundled
 * dependency lands in the map as the path it took to get there:
 *
 *     "../../SDKs/agents_js_sdk/node_modules/lodash/eq.js"
 *
 * That ships one developer's directory layout to every consumer of the package, and
 * it makes two builds of the same commit produce different bytes for no reason. It is
 * cosmetic — nothing loads those paths — but it is free to fix and awkward to explain.
 *
 * So: anything under a `node_modules/` is rewritten to start there, and nothing else
 * is touched. Our own sources are already clean (`../src/foo.ts`) and stay exactly as
 * they are, which is the half that actually gets used when someone debugs the SDK.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

let files = 0;
let rewritten = 0;
for (const name of readdirSync(dist)) {
  if (!name.endsWith(".map")) continue;
  const path = join(dist, name);
  const map = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(map.sources)) continue;
  let touched = false;
  map.sources = map.sources.map((src) => {
    // The LAST occurrence: a nested dependency legitimately has several.
    const at = src.lastIndexOf("node_modules/");
    if (at < 0) return src;
    touched = true;
    rewritten++;
    return src.slice(at);
  });
  if (touched) {
    writeFileSync(path, JSON.stringify(map));
    files++;
  }
}
console.log(`sourcemaps: normalized ${rewritten} paths across ${files} file(s)`);
