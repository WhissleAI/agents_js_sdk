import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  // ESM + CJS for bundlers/npm, plus an IIFE global (window.WhissleAgents) for a
  // plain <script> tag from a CDN.
  format: ["esm", "cjs", "iife"],
  globalName: "WhissleAgents",
  dts: true,
  clean: true,
  minify: true,
  sourcemap: true,
  outExtension({ format }) {
    if (format === "iife") return { js: ".global.js" };
    if (format === "cjs") return { js: ".cjs" };
    return { js: ".js" };
  },
});
