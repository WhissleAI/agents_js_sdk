/**
 * Turn the lines in rehearsal.json into wav files, so a take can be re-shot exactly.
 *
 *   npm run rehearsal
 *
 * macOS `say` writes the audio; on Linux, `espeak-ng -w file.wav "…"` does the same
 * job and this script uses it when `say` isn't there. The wavs are gitignored — they
 * are build output of the script, which is the thing worth keeping.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = JSON.parse(readFileSync(join(here, "rehearsal.json"), "utf8"));

const has = (bin) => {
  try { execFileSync("which", [bin], { stdio: "ignore" }); return true; } catch { return false; }
};
const engine = has("say") ? "say" : has("espeak-ng") ? "espeak-ng" : null;
if (!engine) {
  console.error("  Need `say` (macOS) or `espeak-ng` (Linux) to synthesise the rehearsal lines.");
  process.exit(1);
}

for (const cue of script.cues) {
  const out = join(here, cue.file);
  if (existsSync(out) && !process.env.FORCE) {
    console.log(`  kept    ${cue.file}`);
    continue;
  }
  if (engine === "say") {
    execFileSync("say", ["-o", out, "--data-format=LEI16@22050", "-r", String(cue.rate ?? 175), cue.say]);
  } else {
    execFileSync("espeak-ng", ["-w", out, "-s", String(cue.rate ?? 160), cue.say]);
  }
  console.log(`  wrote   ${cue.file}  “${cue.say}”`);
}
console.log(`\n  Now: open http://localhost:4100/?rehearse=1 and press Start.\n`);
