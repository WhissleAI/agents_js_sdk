/**
 * Type-check every TypeScript snippet in README.md against the SDK's own source,
 * under `--strict`.
 *
 * A README is API surface. Its snippets are what a third party pastes first, and
 * one that does not compile is a bug report from someone who has already decided
 * the library is careless. This repo's sibling `@whissle/sdk` has had this guard
 * since 0.3.0; the browser SDK went without it for four releases, which is how a
 * README came to describe an `emotion` field that is deliberately absent and an
 * event payload nobody could have pasted.
 *
 * How a snippet is compiled:
 *
 *   * `import` lines are hoisted to the top of the generated module (they cannot
 *     live inside a function), and `@whissle/agents` is rewritten to
 *     `src/index.ts` so this checks the CURRENT code, not a published version.
 *   * the rest of the snippet is wrapped in an `async` function, so top-level
 *     `await` is fine — as it is in every bundler a browser SDK ships through.
 *   * a small ambient PREAMBLE declares the identifiers a prose example
 *     legitimately assumes it is surrounded by (a live `agent`, the caller's own
 *     `render`/`show` helpers). A snippet that declares one itself shadows the
 *     ambient one.
 *   * only ```ts / ```typescript fences are considered. `html` and `bash` blocks
 *     are markup and shell, and are checked by reading them.
 *
 * There is no skip marker, deliberately: a fence you are allowed to exempt is a
 * fence that rots. A block that cannot be made to compile should be prose.
 *
 * Run: `npm run check:readme`
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = resolve(import.meta.dirname, "..");
const README = join(ROOT, "README.md");
const ENTRY = join(ROOT, "src/index.ts").replace(/\\/g, "/");

const PREAMBLE = `
import type { WhissleAgent as _A } from "${ENTRY}";
declare const agent: _A;
declare const apiKey: string;
declare const agentId: string;
declare const token: string;
declare const AGENT_ID: string;
declare const render: (text: string) => void;
declare const show: (text: string) => void;
declare const showBillingLink: () => void;
declare const showRetry: (tool?: string) => void;
declare const showLeaning: (label: string, confidence?: number) => void;
declare const strip: { toggle: (active: boolean, label?: string) => void };
declare const process: { env: Record<string, string | undefined> };
export {};
`;

/** Every fenced block whose language is ts/typescript, with its line number. */
function snippets(markdown) {
  const out = [];
  const lines = markdown.split("\n");
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (!fence) return;
    if (open) {
      if (open.lang === "ts" || open.lang === "typescript") {
        out.push({ line: open.line, code: lines.slice(open.line, i).join("\n") });
      }
      open = null;
    } else {
      open = { lang: fence[1] ?? "", line: i + 1 };
    }
  });
  return out;
}

const md = readFileSync(README, "utf8");
const all = snippets(md);
const dir = mkdtempSync(join(tmpdir(), "whissle-agents-readme-"));
const files = [];

all.forEach((snippet, n) => {
  // An import may span several lines (`import {\n  A, B,\n} from "…"`), so
  // consume until the `from "…"` that ends it.
  const imports = [];
  const body = [];
  const lines = snippet.code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*import\s/.test(lines[i])) {
      body.push(lines[i]);
      continue;
    }
    const start = i;
    while (i < lines.length && !/from\s+"[^"]+"/.test(lines[i])) i++;
    imports.push(lines.slice(start, i + 1).join("\n"));
  }
  const rewritten = imports.map((l) =>
    l.replace('"@whissle/agents"', JSON.stringify(ENTRY)),
  );
  const file = join(dir, `snippet-${files.length}.ts`);
  writeFileSync(
    file,
    `${PREAMBLE}\n${rewritten.join("\n")}\n\n// README.md line ${snippet.line}\nexport async function snippet${n}() {\n${body.join("\n")}\n}\n`,
  );
  files.push({ file, line: snippet.line });
});

if (!files.length) {
  console.error("no TypeScript snippets found in README.md — has the fence syntax changed?");
  process.exit(1);
}

try {
  execFileSync(
    "npx",
    [
      "tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2020",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--lib",
      "ES2020,ES2021.WeakRef,DOM,DOM.Iterable",
      "--skipLibCheck",
      "--allowImportingTsExtensions",
      "--esModuleInterop",
      ...files.map((f) => f.file),
    ],
    { cwd: ROOT, stdio: "pipe", encoding: "utf8" },
  );
} catch (err) {
  const output = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  // Point at the README line, not the temp file nobody has.
  const mapped = output.replace(
    /snippet-(\d+)\.ts/g,
    (_m, n) => `README.md (snippet at line ${files[Number(n)]?.line})`,
  );
  console.error(mapped.trim());
  console.error(`\n✖ ${files.length} README snippet(s) checked — at least one does not compile.`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
console.log(`✔ ${files.length} README TypeScript snippet(s) compile under --strict.`);
