import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { RelayConfig } from "../config/relay.js";
import { exec, shell } from "./exec.js";

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  critical: boolean;
}

export interface PreflightReport {
  passed: boolean;
  checks: PreflightCheck[];
}

/**
 * Which slice of the preflight battery to run.
 *
 * - "pre-pull" — checks that only carry signal BEFORE `git pull`:
 *   working tree cleanliness (so `git pull` doesn't clobber WIP) and
 *   remote reachability (so we don't bother trying). Both are tautologies
 *   AFTER a successful pull, so the engine runs them in this slice
 *   exclusively.
 * - "post-pull" — checks against the freshly-pulled tree: compose file
 *   present, traefik labels in the compose, health endpoint configured,
 *   containers actually running. Engine runs these after `reload .relay.yml`
 *   so the new commit's config is the one being validated.
 * - "all" — both slices. The standalone `GET /api/apps/:name/preflight`
 *   endpoint and command-mode deploys (where there's no natural pre/post
 *   pull split) use this.
 */
export type PreflightPhase = "pre-pull" | "post-pull" | "all";

export interface PreflightOptions {
  appDir: string;
  config: RelayConfig;
  force?: boolean;
  phase?: PreflightPhase;
}

export async function runPreflightChecks(options: PreflightOptions): Promise<PreflightReport> {
  const { appDir, config, force = false, phase = "all" } = options;

  const tasks: Array<Promise<PreflightCheck>> = [];
  if (phase === "pre-pull" || phase === "all") {
    tasks.push(checkGitClean(appDir));
    tasks.push(checkGitRemoteReachable(appDir));
  }
  if (phase === "post-pull" || phase === "all") {
    tasks.push(checkComposeFileExists(appDir, config.compose_file));
    tasks.push(checkContainersRunning(appDir, config.compose_file));
    tasks.push(checkTraefikLabels(appDir, config.compose_file));
    tasks.push(checkHealthDefined(config));
  }
  const checks = await Promise.all(tasks);

  const passed = force
    ? checks.filter((c) => c.critical).every((c) => c.passed)
    : checks.every((c) => c.passed);

  return { passed, checks };
}

async function checkComposeFileExists(appDir: string, composeFile: string): Promise<PreflightCheck> {
  const path = join(appDir, composeFile);
  try {
    await access(path);
    return { name: "compose_file_exists", passed: true, message: `${composeFile} found`, critical: true };
  } catch {
    return { name: "compose_file_exists", passed: false, message: `${composeFile} not found in ${appDir}`, critical: true };
  }
}

async function checkContainersRunning(appDir: string, composeFile: string): Promise<PreflightCheck> {
  const result = await exec("docker", ["compose", "-f", composeFile, "ps", "--format", "json", "-q"], appDir);
  if (result.exitCode !== 0) {
    return { name: "containers_running", passed: false, message: "Failed to check containers: " + result.stderr, critical: false };
  }
  const hasContainers = result.stdout.trim().length > 0;
  return {
    name: "containers_running",
    passed: hasContainers,
    message: hasContainers ? "Containers are running" : "No running containers found — initial deploy?",
    critical: false,
  };
}

async function checkTraefikLabels(appDir: string, composeFile: string): Promise<PreflightCheck> {
  const path = join(appDir, composeFile);
  try {
    const content = await readFile(path, "utf-8");
    const hasTraefik = content.includes("traefik");
    return {
      name: "traefik_labels",
      passed: hasTraefik,
      message: hasTraefik ? "Traefik labels found" : "No traefik labels in compose file",
      critical: false,
    };
  } catch {
    return { name: "traefik_labels", passed: false, message: "Could not read compose file", critical: false };
  }
}

async function checkHealthDefined(config: RelayConfig): Promise<PreflightCheck> {
  const hasHealth = config.health.trim().length > 0;
  return {
    name: "health_defined",
    passed: hasHealth,
    message: hasHealth ? `Health endpoint: ${config.health}` : "No health endpoint defined",
    critical: true,
  };
}

async function checkGitClean(appDir: string): Promise<PreflightCheck> {
  const result = await shell("git status --porcelain", appDir);
  if (result.exitCode !== 0) {
    return { name: "git_clean", passed: false, message: "Failed to check git status: " + result.stderr, critical: false };
  }
  const clean = result.stdout.trim().length === 0;
  return {
    name: "git_clean",
    passed: clean,
    message: clean ? "Working tree clean" : "Uncommitted changes detected",
    critical: false,
  };
}

async function checkGitRemoteReachable(appDir: string): Promise<PreflightCheck> {
  const result = await shell("git ls-remote --exit-code origin HEAD", appDir);
  const reachable = result.exitCode === 0;
  return {
    name: "git_remote_reachable",
    passed: reachable,
    message: reachable ? "Git remote is reachable" : "Cannot reach git remote",
    critical: false,
  };
}
