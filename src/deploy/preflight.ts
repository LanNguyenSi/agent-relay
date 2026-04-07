import { readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { RelayConfig } from "../config/relay.js";
import { shell } from "./exec.js";

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

export interface PreflightOptions {
  appDir: string;
  config: RelayConfig;
  force?: boolean;
}

export async function runPreflightChecks(options: PreflightOptions): Promise<PreflightReport> {
  const { appDir, config, force = false } = options;

  const checks = await Promise.all([
    checkComposeFileExists(appDir, config.compose_file),
    checkContainersRunning(appDir, config.compose_file),
    checkTraefikLabels(appDir, config.compose_file),
    checkHealthDefined(config),
    checkGitClean(appDir),
    checkGitRemoteReachable(appDir),
  ]);

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
  const result = await shell(`docker compose -f '${composeFile}' ps --format json -q`, appDir);
  if (result.exitCode !== 0) {
    return { name: "containers_running", passed: false, message: "Failed to check containers: " + result.stderr, critical: true };
  }
  const hasContainers = result.stdout.trim().length > 0;
  return {
    name: "containers_running",
    passed: hasContainers,
    message: hasContainers ? "Containers are running" : "No running containers found",
    critical: true,
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
  const hasHealth = config.health.length > 0;
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
  const result = await shell("git ls-remote --exit-code --heads origin HEAD", appDir);
  const reachable = result.exitCode === 0;
  return {
    name: "git_remote_reachable",
    passed: reachable,
    message: reachable ? "Git remote is reachable" : "Cannot reach git remote",
    critical: true,
  };
}
