import { resolve, sep, dirname, basename, isAbsolute } from "node:path";
import { readdir, stat, lstat, readlink, realpath } from "node:fs/promises";
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

// realpath() requires every path segment to exist, so it can't tell us where
// a DANGLING symlink's target really is. This walks up to the nearest
// existing ancestor, resolves *that* (following any symlinks in it, e.g. a
// symlinked APPS_DIR parent), then rebuilds the missing tail on top —
// the one-level fallback safeAppDir applies to `appsRoot` itself,
// generalized to arbitrary depth so it also normalizes a dangling
// symlink's own target path before it's compared against `appsReal`. Fed a
// RAW (not pre-collapsed via path.resolve()) path string, this also
// resolves a `..` that follows a symlink in kernel order rather than
// lexically — see resolveSymlinkChain below, which is what supplies that
// raw string.
// The root side deliberately KEEPS its one-level fallback: if APPS_DIR
// itself does not exist there is nothing inside it to check, so the two
// sides intentionally do not share this helper.
async function bestEffortReal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = dirname(path);
    if (parent === path) return path; // reached filesystem root
    return resolve(await bestEffortReal(parent), basename(path));
  }
}

// SYMLOOP_MAX analog: bounds how many hops resolveSymlinkChain will follow
// through a manufactured chain of individually-dangling symlinks. A single
// fully-materialized chain is already bounded by the kernel's own ELOOP
// detection inside bestEffortReal's realpath() call; this guards the case
// that detection can't see — each hop below is a SEPARATE readlink() +
// realpath() round trip (not one syscall spanning the whole chain), so a
// sufficiently long or cyclic manufactured chain would otherwise recurse
// without the kernel ever getting to count it in a single lookup.
const MAX_SYMLINK_DEPTH = 40;

// Resolves a symlink's target (`raw`, as read via readlink()) to its
// best-effort real location, starting from the directory (`base`) the
// symlink itself lives in. Two escape variants this closes beyond the
// single-jump case already handled by bestEffortReal/PR #68:
//   - Chained dangling symlinks (e.g. apps/danger -> apps/hop -> <outside>,
//     where NEITHER leg exists on disk yet): bestEffortReal's rebuilt
//     candidate can itself still be a symlink, since bestEffortReal only
//     walks up to the nearest existing ANCESTOR — it never re-checks
//     whether the tail it reattaches is itself a link. This function does,
//     recursively, up to MAX_SYMLINK_DEPTH.
//   - Lexical `..` collapse through an existing outward-pointing symlink
//     (e.g. apps/hop3 -> <outside>/deep (exists), apps/danger3 ->
//     "hop3/../newdir" (the "newdir" tail doesn't exist)): `raw` is
//     concatenated onto `base` WITHOUT going through path.resolve() first.
//     resolve() cannot tell a real directory segment from a symlink that
//     points elsewhere, so it would collapse the embedded `..` ahead of
//     any symlink check and land back inside APPS_DIR even though the
//     kernel — which applies `..` only AFTER following the symlink ahead
//     of it — would land outside. Keeping `..` as a literal path segment
//     and letting bestEffortReal's realpath() call do the resolving
//     applies it in that same, correct order.
// This is still defense-in-depth, not a closure of the underlying TOCTOU
// window (the filesystem can change between this check and a later write)
// or of a symlink that resolves to APPS_DIR itself — both out of scope.
async function resolveSymlinkChain(base: string, raw: string, depth = 0): Promise<string> {
  if (depth >= MAX_SYMLINK_DEPTH) {
    const err = new Error("Too many levels of symbolic links") as NodeJS.ErrnoException;
    err.code = "ELOOP";
    throw err;
  }
  const targetPath = isAbsolute(raw) ? raw : base + sep + raw;
  const real = await bestEffortReal(targetPath);
  const link = await lstat(real).catch(() => null);
  if (!link?.isSymbolicLink()) return real;
  const nextTarget = await readlink(real);
  return resolveSymlinkChain(dirname(real), nextTarget, depth + 1);
}

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
  const real = await realpath(realBase).catch(async (err: NodeJS.ErrnoException) => {
    // Only ENOENT gets the dangling-symlink treatment below. Every other
    // error class (ELOOP, ENOTDIR, EACCES, ...) keeps the pre-existing
    // tolerant fallback to the in-dir child path, same posture as
    // listApps' deliberate ELOOP tolerance: this check stays scoped to
    // the dangling-link case, and the kernel cannot follow what it
    // cannot resolve, so nothing new escapes through that fallback.
    if (err.code !== "ENOENT") return realBase;
    // realpath() throws ENOENT both when `realBase` simply doesn't exist yet
    // (a never-deployed app: fall back to the unresolved path, handled
    // below) and when it exists as a DANGLING top-level symlink whose
    // target doesn't exist yet — e.g. APPS_DIR/<name> -> /etc, planted
    // before the target path is created. realpath can't resolve a target
    // that doesn't exist, so it ENOENTs in both cases; lstat (which does
    // NOT follow symlinks) tells them apart. For the symlink case we
    // resolve the link target ourselves via resolveSymlinkChain() — the
    // same normalization realpath would apply once the target exists,
    // generalized to follow a CHAIN of dangling symlinks (not just the
    // immediate one) and to apply an embedded `..` in kernel order rather
    // than lexically (see resolveSymlinkChain's own comment for both
    // variants this closes) — and reject it here if that target escapes
    // APPS_DIR, instead of silently falling back to the in-dir child path
    // and letting a later write follow the link out.
    const link = await lstat(realBase).catch(() => null);
    if (link?.isSymbolicLink()) {
      try {
        const target = await readlink(realBase);
        const resolvedTarget = await resolveSymlinkChain(dirname(realBase), target);
        if (resolvedTarget !== appsReal && !resolvedTarget.startsWith(appsReal + sep)) {
          throw new RelayConfigError("App path escapes APPS_DIR");
        }
      } catch (linkErr) {
        if (linkErr instanceof RelayConfigError) throw linkErr;
        // Same posture as the non-ENOENT branch above: an unresolvable
        // link target (ELOOP chain — including a manufactured chain
        // exceeding MAX_SYMLINK_DEPTH — EACCES, a dirent racing away)
        // falls back to the pre-existing in-dir child path instead of
        // leaking a raw errno out of the API as a 500.
        return realBase;
      }
    }
    return realBase;
  });
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
