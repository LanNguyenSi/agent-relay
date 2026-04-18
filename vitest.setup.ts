// Satisfy required env vars before any test file imports `src/config/env.ts`.
// Tests that need to exercise real filesystem behaviour override APPS_DIR in
// their own beforeEach — this default only keeps the validation schema happy.
process.env.AUTH_TOKEN ??= "test-token-x".repeat(3);
process.env.APPS_DIR ??= "/tmp/agent-relay-test-apps-default";
