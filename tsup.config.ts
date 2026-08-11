import { defineConfig } from "tsup";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

// The two optional renderers. In ESM/CJS they are lazy `import()`s, so a
// bundler puts each in its own chunk that a voice-only app never downloads. An
// IIFE has no chunks — esbuild inlines a dynamic import into the one file — so
// bundling them here would make every plain <script> user pay ~1 MB for a
// feature they may not use. Hence two globals; see `avatarCapable` below.
const LAZY_RENDERERS = ["simli-client/dist/client.js", "livekit-client"];

// Three builds:
//  - ESM + CJS for bundlers/npm. Deps stay external — the consumer's bundler
//    (webpack/vite) resolves and polyfills them.
//  - A standalone IIFE global (window.WhissleAgents) for a plain <script> tag.
//    This one bundles EVERYTHING except the lazy renderers, so we target the
//    browser (so uuid & friends pick their browser builds, not node:crypto) and
//    alias the two Node built-ins @pipecat-ai/client-js pulls in (events, util)
//    to their browser polyfills — otherwise the IIFE throws "Dynamic require of
//    'events'" at load and the global is never defined.
//  - The same IIFE with the renderers bundled in (index.full.global.js), for a
//    <script>-tag page that wants an avatar or LiveKit.
export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    minify: true,
    sourcemap: true,
    // @pipecat-ai/small-webrtc-transport is bundled IN, unlike our other deps,
    // to defuse a Node-ESM landmine we cannot fix in its source: its ESM build
    // does `import cloneDeep from "lodash/cloneDeep"` — extensionless, which
    // bundlers and `require()` resolve happily but raw Node ESM refuses
    // ("Did you mean to import lodash/cloneDeep.js?"). That made
    // `await import("@whissle/agents")` throw in any Node-ESM/SSR context — a
    // Next.js server component, a script, an SSR render pass — before a single
    // line of our code ran. Bundling it lets the plugin below rewrite that one
    // specifier at build time, and inlines cloneDeep so nothing resolves lodash
    // at runtime at all.
    noExternal: ["@pipecat-ai/small-webrtc-transport"],
    esbuildPlugins: [
      {
        name: "lodash-extensionful",
        setup(build) {
          build.onResolve({ filter: /^lodash\/[^.]+$/ }, (args) => ({
            path: require.resolve(`${args.path}.js`),
          }));
        },
      },
    ],
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  ...[false, true].map((avatarCapable) => ({
    entry: ["src/index.ts"],
    format: ["iife" as const],
    globalName: "WhissleAgents",
    dts: false,
    clean: false,
    minify: true,
    sourcemap: true,
    outExtension() {
      return { js: avatarCapable ? ".full.global.js" : ".global.js" };
    },
    esbuildOptions(options: { platform?: string; define?: Record<string, string>; alias?: Record<string, string> }) {
      options.platform = "browser";
      options.define = { ...options.define, global: "globalThis" };
      options.alias = {
        ...options.alias,
        events: require.resolve("events/"),
        util: require.resolve("util/"),
        // The lean global points the renderers at a module that throws a
        // sentence telling you which build to use; the full global bundles the
        // real ones. `external` is not an option here: esbuild has to inline
        // every dynamic import to produce a single IIFE.
        ...(avatarCapable
          ? {}
          : Object.fromEntries(
              LAZY_RENDERERS.map((m) => [m, require.resolve("./src/renderer-unavailable.ts")]),
            )),
      };
    },
  })),
]);
