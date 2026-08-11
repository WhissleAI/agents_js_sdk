/**
 * Stand-in for the lazily-loaded renderers (simli-client, livekit-client) in the
 * LEAN `<script>` build.
 *
 * A plain-script page gets one file with no code splitting, so bundling the
 * renderers there would charge every voice-only widget ~1 MB for a face it never
 * shows. The lean global therefore aliases them to this module, which throws the
 * moment one is actually needed — and that rejection is caught upstream, so the
 * conversation still connects audio-only with an `avatar-failed` event carrying
 * this exact sentence.
 *
 * Nothing aliases this in the npm (ESM/CJS) builds: there, `import()` resolves
 * the real packages into their own chunks.
 */
throw new Error(
  "This build has no avatar/LiveKit renderer. Use the full script build " +
    "(https://unpkg.com/@whissle/agents/dist/index.full.global.js), or install " +
    "@whissle/agents from npm, where the renderer loads on demand.",
);

export {};
