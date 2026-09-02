/**
 * `@mediapipe/tasks-vision` is an OPTIONAL peer dependency: the SDK must compile
 * — under `--strict`, `--skipLibCheck false` — whether or not the host installed
 * it. This shorthand ambient declaration makes the dynamic `import()` specifier
 * resolvable either way; `./gestures` immediately casts the module to its own
 * hand-typed `VisionModule` sliver, so nothing downstream sees `any`.
 */
declare module "@mediapipe/tasks-vision";
