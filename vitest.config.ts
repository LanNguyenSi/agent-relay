import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Restrict discovery to source tests. Without this, vitest's default
    // glob also matches compiled `dist/**/*.test.js` after `npm run build`,
    // causing src + dist copies of the same test to race on shared fs
    // fixtures (EEXIST on mkdir of `/tmp/agent-relay-test-apps-default/demo`).
    include: ["src/**/*.{test,spec}.ts"],
    coverage: {
      provider: "v8",
      // Include only source files, not test files or generated dist output.
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/**/*.spec.ts",
        // Entry point — starts the server and binds the port.
        // It cannot be unit-tested without a real network stack,
        // so exclude it from the enforced threshold.
        "src/index.ts",
      ],
      // Thresholds ratcheted to measured coverage after the 2026-06-28
      // test-coverage pass (with src/index.ts excluded; baseline before
      // new tests: 0 coverage on 5 gaps). Set slightly below actuals
      // to give headroom for minor fluctuations while locking in gains.
      // Actuals with new tests: stmts 79.18%, branch 70.67%,
      // funcs 81.48%, lines 81.66%.
      thresholds: {
        statements: 79,
        branches: 70,
        functions: 81,
        lines: 81,
      },
    },
  },
});
