import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// ESLint flat config for agent-relay (plain Node + TypeScript, no framework).
// Mirrors the pattern used in sibling org repos (e.g. agent-tasks/backend):
// non-type-checked recommended so it stays fast and doesn't require the full
// TS program. Soft-start rules below keep v1 lean; see the PR body for the
// backlog this surfaced.
export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    // Soft start: the repo has never been linted. Demote the noisiest
    // stylistic rules to warnings so the first pass is exit-0 without a
    // sprawling refactor. Genuine errors (and any rule not listed here)
    // still fail the build, and the warnings are a visible backlog to burn
    // down as a follow-up.
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
