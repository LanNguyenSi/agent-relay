/**
 * Shared branch-name validation. Lives in its own module with no imports so
 * both `src/services/apps.ts` (a caller-supplied branch at the HTTP/MCP
 * deploy entrypoints) and `src/deploy/engine.ts` (the auto-detected branch
 * from `git rev-parse --abbrev-ref HEAD`) enforce the same rule without an
 * import cycle: apps.ts imports engine.ts, so the engine must not import
 * apps.ts back.
 */

// Option-injection guard: the branch reaches git's argv through
// `git pull origin <branch>`, so a value git would read as an option (any
// leading dash, e.g. `--prune`) must never get there; the pattern requires
// a leading letter or digit. `HEAD` is rejected too: a detached checkout
// reports exactly that string, and `git pull origin HEAD` would fetch the
// remote's default branch instead of the code that is checked out (git
// itself refuses to name a branch `HEAD`, so the rejection takes away no
// legitimate deploy).
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export function validateBranch(branch: string): string {
  if (!BRANCH_NAME.test(branch) || branch === "HEAD") throw new Error("Invalid branch name");
  return branch;
}
