import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// ESLint flat config for agent-relay (plain Node + TypeScript, no framework).
// Mirrors the pattern used in sibling org repos (e.g. agent-tasks/backend):
// non-type-checked recommended so it stays fast and doesn't require the full
// TS program.
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
    // The initial soft-start backlog (7x no-explicit-any, 1x no-unused-vars)
    // has been burned down, so both rules are promoted to error. Kept as an
    // explicit block (rather than relying on tseslint.configs.recommended's
    // defaults) so the argsIgnorePattern/varsIgnorePattern/
    // caughtErrorsIgnorePattern convention for intentionally-unused `_`-
    // prefixed bindings stays documented and enforced.
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
    },
  },
);
