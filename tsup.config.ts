import { defineConfig } from "tsup";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// Two builds:
//  - ESM + CJS for bundlers/npm. Deps stay external — the consumer's bundler
//    (webpack/vite) resolves and polyfills them.
//  - A standalone IIFE global (window.WhissleAgents) for a plain <script> tag.
//    This one bundles EVERYTHING, so we target the browser (so uuid & friends
//    pick their browser builds, not node:crypto) and alias the two Node built-ins
//    @pipecat-ai/client-js pulls in (events, util) to their browser polyfills —
//    otherwise the IIFE throws "Dynamic require of 'events'" at load and the
//    global is never defined.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    minify: true,
    sourcemap: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    entry: ["src/index.ts"],
    format: ["iife"],
    globalName: "WhissleAgents",
    dts: false,
    clean: false,
    minify: true,
    sourcemap: true,
    outExtension() {
      return { js: ".global.js" };
    },
    esbuildOptions(options) {
      options.platform = "browser";
      options.define = { ...options.define, global: "globalThis" };
      options.alias = {
        ...options.alias,
        events: require.resolve("events/"),
        util: require.resolve("util/"),
      };
    },
  },
]);
