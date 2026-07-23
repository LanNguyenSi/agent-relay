import { resolve, sep } from "node:path";
import { readdir, stat, realpath } from "node:fs/promises";
import { env } from "../config/env.js";
import { loadRelayConfig, RelayConfigError } from "../config/relay.js";
import { deploy } from "../deploy/engine.js";
import { runPreflightChecks } from "../deploy/preflight.js";
import { runExec } from "../deploy/exec.js";

// Preflight used to run here before git pull. That meant a commit that
// *fixed* a broken .relay.yml (wrong compose_file, missing `command:`,
// etc.) failed preflight against the still-broken pre-pull copy on
// disk — the merged fix couldn't be applied. Preflight now runs inside
// the deploy engine (`deploy/engine.ts`) against the post-pull config
// for default-flow deploys; command-mode deploys keep the pre-command
// preflight since the command is opaque. Operators who need the
// standalone preflight view (e.g. the ops dashboard) use
// `runPreflight(name)` below, which still reads the current working
// tree.

export { RelayConfigError };

const APP_NAME = /^[a-zA-Z0-9_-]+$/;
const COMMIT_REF = /^[a-fA-F0-9]{4,40}$|^HEAD~\d{1,3}$/;
const SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;
const BRANCH_NAME = /^[a-zA-Z0-9._/-]+$/;
const MAX_LOG_LINES = 1000;

export async function safeAppDir(name: string): Promise<string> {
  if (!APP_NAME.test(name)) throw new RelayConfigError("Invalid app name");
  const appsRoot = resolve(env.APPS_DIR);
  const dir = resolve(appsRoot, name);
  // `startsWith(appsRoot + sep)` (not just `appsRoot`) prevents a sibling-name
  // prefix false-positive: without the trailing separator `appsRoot = /apps`
  // would accept `/appsteak/...` as contained. Mirrors assertComposeFileContained.
  if (dir !== appsRoot && !dir.startsWith(appsRoot + sep)) {
    throw new RelayConfigError("Invalid app path");
  }
  // Resolve APPS_DIR's real path FIRST, then rebuild the app dir from that
  // resolved root before resolving symlinks on the app dir itself — both
  // sides of the containment check below must go through the same
  // normalization. Building the child from the unresolved `appsRoot` (via
  // `dir` above) and only falling back to that unresolved string when
  // `realpath(dir)` fails (ENOENT — the app doesn't exist yet, e.g. an app
  // never deployed) compares an unresolved child against a resolved parent.
  // That's a false positive whenever APPS_DIR's own path crosses a symlink
  // (e.g. /tmp -> /private/tmp or /var -> /private/var): the nonexistent
  // child keeps the symlinked prefix while the parent loses it, so a
  // genuinely-contained app dir looks like it escapes. Deriving the
  // fallback from `appsReal` keeps both sides in the same normalized form
  // while still resolving (and rejecting) a symlink escape inside the app
  // dir itself. The same trailing-separator guard applies after realpath,
  // so a symlink to a sibling-prefixed directory (e.g. /apps/x -> /appsteak)
  // cannot escape.
  const appsReal = await realpath(appsRoot).catch(() => appsRoot);
  const realBase = resolve(appsReal, name);
  const real = await realpath(realBase).catch(() => realBase);
  if (real !== appsReal && !real.startsWith(appsReal + sep)) {
    throw new RelayConfigError("App path escapes APPS_DIR");
  }
  return real;
}

export function validateCommitRef(ref: string): string {
  if (!COMMIT_REF.test(ref)) throw new Error("Invalid commit reference");
  return ref;
}

export function validateServiceName(name: string): string {
  if (!SERVICE_NAME.test(name)) throw new Error("Invalid service name");
  return name;
}

export function validateBranch(branch: string): string {
  if (!BRANCH_NAME.test(branch)) throw new Error("Invalid branch name");
  return branch;
}

export function clampLogLines(lines?: number): number {
  return Math.min(lines ?? 50, MAX_LOG_LINES);
}

export async function listApps(): Promise<Array<{ name: string; configured: boolean; health?: string; commit?: string }>> {
  try {
    const entries = await readdir(env.APPS_DIR, { withFileTypes: true });
    // Follow symlinks: isDirectory() returns false for symlinks, so stat() to resolve
    const names = await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return e.name;
        if (e.isSymbolicLink()) {
          const s = await stat(resolve(env.APPS_DIR, e.name)).catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT" || err.code === "ELOOP") return null;
            throw err;
          });
          if (s?.isDirectory()) return e.name;
        }
        return null;
      }),
    );
    const dirs = names.filter((n): n is string => n !== null);

    return Promise.all(dirs.map(async (name) => {
      const dir = resolve(env.APPS_DIR, name);
      try {
        const config = await loadRelayConfig(dir);
        const commit = await runExec("git", ["rev-parse", "--short", "HEAD"], dir);
        return { name, configured: true, health: config.health, commit: commit.stdout.trim() || "unknown" };
      } catch {
        return { name, configured: false };
      }
    }));
  } catch {
    return [];
  }
}

export async function getAppDetail(name: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const commit = await runExec("git", ["rev-parse", "--short", "HEAD"], dir);
  const ps = await runExec("docker", ["compose", "-f", config.compose_file, "ps", "--format", "json"], dir);

  return {
    name,
    config,
    commit: commit.stdout.trim(),
    containers: ps.exitCode === 0 ? ps.stdout.trim() : null,
  };
}

export async function deployApp(name: string, options?: { branch?: string; force?: boolean }) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const branch = options?.branch ? validateBranch(options.branch) : undefined;
  return deploy({ appDir: dir, config, branch, force: options?.force });
}

export async function deployAppStreaming(
  name: string,
  options?: { branch?: string; force?: boolean },
  onStep?: (step: import("../deploy/engine.js").DeployStep) => void,
) {
  const dir = await safeAppDir(name);
  // Pre-pull config: the engine re-loads .relay.yml after `git pull`
  // so build/up/post_update/health/preflight see the post-pull config.
  const config = await loadRelayConfig(dir);
  const branch = options?.branch ? validateBranch(options.branch) : undefined;
  return deploy({
    appDir: dir,
    config,
    branch,
    force: options?.force,
    onStep,
  });
}

export async function rollbackApp(name: string, toCommit?: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const target = toCommit ? validateCommitRef(toCommit) : "HEAD~1";

  const commitBefore = (await runExec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();

  const checkout = await runExec("git", ["reset", "--hard", target], dir);
  if (checkout.exitCode !== 0) throw new Error("Rollback failed: " + checkout.stderr);

  const build = await runExec("docker", ["compose", "-f", config.compose_file, "build"], dir);
  if (build.exitCode !== 0) throw new Error("Rebuild failed: " + build.stderr);

  const up = await runExec("docker", ["compose", "-f", config.compose_file, "up", "-d"], dir);
  if (up.exitCode !== 0) throw new Error("Restart failed: " + up.stderr);

  const commitAfter = (await runExec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
  return { success: true, commitBefore, commitAfter };
}

export async function fetchLogs(name: string, lines?: number, service?: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const n = clampLogLines(lines);
  const svc = service ? validateServiceName(service) : "";

  const result = await runExec(
    "docker",
    ["compose", "-f", config.compose_file, "logs", `--tail=${n}`, "--no-color", ...(svc ? [svc] : [])],
    dir,
  );

  if (result.exitCode !== 0) throw new Error("Failed to get logs: " + result.stderr);
  return { app: name, lines: n, logs: result.stdout };
}

export async function runPreflight(name: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  return runPreflightChecks({ appDir: dir, config });
}
