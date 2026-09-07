import { defineConfig } from "vitest/config";

// The module is browser code, but nothing here needs a DOM: the Foundry globals
// it touches are stubbed in test/module-runtime.test.mjs, and the one piece of
// HTML handling it does (reducing v14's ProseMirror output to the typed text)
// is deliberately string work so that this suite covers the same code path a
// GM runs. Adding a DOM environment would make that untrue.
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "test/**/*.test.mjs",
      // The repo-maintenance scripts are plain .mjs but ship with their own
      // vitest suites, so a change to a shared script module is caught by
      // `npm test` rather than at the moment it matters.
      "scripts/**/*.test.mjs",
    ],
    fileParallelism: false,
  },
});
