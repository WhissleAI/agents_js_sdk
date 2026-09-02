/**
 * Stand-in for `@mediapipe/tasks-vision` in the `<script>`-tag (IIFE) builds.
 *
 * The recognizer is an OPTIONAL peer dependency: on npm the lazy `import()`
 * resolves it when the host installed it, and rejects when they didn't. An IIFE
 * has no npm install to resolve against and must be self-contained, so both
 * script builds alias the specifier here — this module throws on evaluation,
 * the engine's `import()` rejects, and that rejection is the same caught path a
 * missing package takes: one console.warn, gestures off, the session untouched.
 */
throw new Error(
  "This build has no gesture recognizer. Install @whissle/agents from npm " +
    "alongside @mediapipe/tasks-vision to use gestures: true.",
);

export {};
