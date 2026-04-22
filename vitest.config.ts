import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./vitest.setup.ts"],
    // Restrict discovery to source tests. Without this, vitest's default
    // glob also matches compiled `dist/**/*.test.js` after `npm run build`,
    // causing src + dist copies of the same test to race on shared fs
    // fixtures (EEXIST on mkdir of `/tmp/agent-relay-test-apps-default/demo`).
    include: ["src/**/*.{test,spec}.ts"],
  },
});
