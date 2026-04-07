import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { env } from "../config/env.js";
import { loadRelayConfig, RelayConfigError } from "../config/relay.js";
import { deploy } from "../deploy/engine.js";
import { runPreflightChecks } from "../deploy/preflight.js";
import { shell } from "../deploy/exec.js";

export { RelayConfigError };

const APP_NAME = /^[a-zA-Z0-9_-]+$/;
const COMMIT_REF = /^[a-fA-F0-9]{4,40}$|^HEAD~\d{1,3}$/;
const SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_LOG_LINES = 1000;

export function safeAppDir(name: string): string {
  if (!APP_NAME.test(name)) throw new RelayConfigError("Invalid app name");
  const dir = resolve(env.APPS_DIR, name);
  if (!dir.startsWith(resolve(env.APPS_DIR))) throw new RelayConfigError("Invalid app path");
  return dir;
}

export function validateCommitRef(ref: string): string {
  if (!COMMIT_REF.test(ref)) throw new Error("Invalid commit reference");
  return ref;
}

export function validateServiceName(name: string): string {
  if (!SERVICE_NAME.test(name)) throw new Error("Invalid service name");
  return name;
}

export function clampLogLines(lines?: number): number {
  return Math.min(lines ?? 50, MAX_LOG_LINES);
}

export async function listApps(): Promise<Array<{ name: string; configured: boolean; health?: string; commit?: string }>> {
  try {
    const entries = await readdir(env.APPS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    return Promise.all(dirs.map(async (name) => {
      const dir = resolve(env.APPS_DIR, name);
      try {
        const config = await loadRelayConfig(dir);
        const commit = await shell("git rev-parse --short HEAD", dir);
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
  const dir = safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const commit = await shell("git rev-parse --short HEAD", dir);
  const ps = await shell(`docker compose -f '${config.compose_file}' ps --format json`, dir);

  return {
    name,
    config,
    commit: commit.stdout.trim(),
    containers: ps.exitCode === 0 ? ps.stdout.trim() : null,
  };
}

export async function deployApp(name: string, options?: { branch?: string; force?: boolean }) {
  const dir = safeAppDir(name);
  const config = await loadRelayConfig(dir);

  const preflight = await runPreflightChecks({ appDir: dir, config, force: options?.force });
  if (!preflight.passed) {
    return { success: false, blocked: true, preflight };
  }

  return deploy({ appDir: dir, config, branch: options?.branch });
}

export async function rollbackApp(name: string, toCommit?: string) {
  const dir = safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const target = toCommit ? validateCommitRef(toCommit) : "HEAD~1";

  const commitBefore = (await shell("git rev-parse HEAD", dir)).stdout.trim();

  const checkout = await shell(`git reset --hard '${target}'`, dir);
  if (checkout.exitCode !== 0) throw new Error("Rollback failed: " + checkout.stderr);

  const build = await shell(`docker compose -f '${config.compose_file}' build`, dir);
  if (build.exitCode !== 0) throw new Error("Rebuild failed: " + build.stderr);

  const up = await shell(`docker compose -f '${config.compose_file}' up -d`, dir);
  if (up.exitCode !== 0) throw new Error("Restart failed: " + up.stderr);

  const commitAfter = (await shell("git rev-parse HEAD", dir)).stdout.trim();
  return { success: true, commitBefore, commitAfter };
}

export async function fetchLogs(name: string, lines?: number, service?: string) {
  const dir = safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const n = clampLogLines(lines);
  const svc = service ? validateServiceName(service) : "";

  const result = await shell(
    `docker compose -f '${config.compose_file}' logs --tail=${n} --no-color ${svc}`.trim(),
    dir,
  );

  if (result.exitCode !== 0) throw new Error("Failed to get logs: " + result.stderr);
  return { app: name, lines: n, logs: result.stdout };
}

export async function runPreflight(name: string) {
  const dir = safeAppDir(name);
  const config = await loadRelayConfig(dir);
  return runPreflightChecks({ appDir: dir, config });
}
