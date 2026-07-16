import { readFile, access, stat, writeFile, unlink } from "node:fs/promises";
import { join, resolve, sep, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import * as yaml from "js-yaml";
import type { RelayConfig } from "../config/relay.js";
import { runExec } from "./exec.js";
import { env } from "../config/env.js";

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
    tasks.push(checkAppsRootMountCongruence());
  }
  if (phase === "post-pull" || phase === "all") {
    tasks.push(checkComposeFileExists(appDir, config.compose_file));
    tasks.push(checkContainersRunning(appDir, config.compose_file));
    tasks.push(checkTraefikLabels(appDir, config.compose_file));
    tasks.push(checkHealthDefined(config));
    tasks.push(checkComposeBindMountSourcesExist(appDir, config.compose_file));
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
  const result = await runExec("docker", ["compose", "-f", composeFile, "ps", "--format", "json", "-q"], appDir);
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
  const result = await runExec("git", ["status", "--porcelain"], appDir);
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
  const result = await runExec("git", ["ls-remote", "--exit-code", "origin", "HEAD"], appDir);
  const reachable = result.exitCode === 0;
  return {
    name: "git_remote_reachable",
    passed: reachable,
    message: reachable ? "Git remote is reachable" : "Cannot reach git remote",
    critical: false,
  };
}

const MOUNT_PROBE_FILENAME = ".agent-relay-mount-probe";

/**
 * Incident 2026-07-15: agent-relay runs `docker compose` INSIDE its own
 * container (DooD). The docker daemon resolves compose bind-mount sources
 * against the HOST filesystem, not the relay container's view. When the
 * host's `/apps` didn't match the relay's in-container `env.APPS_DIR`
 * (mounted from `/root/git` on the host), every file bind-mount of a
 * deployed app was silently auto-created by docker as an EMPTY directory
 * on the host — while deploys reported success.
 *
 * This check proves congruence end-to-end through the daemon: write a
 * marker file inside `env.APPS_DIR` (the relay's own view), then ask the
 * daemon — via a throwaway `docker run` bind-mounting `env.APPS_DIR` —
 * to read that same marker back. If the daemon can't see it (bind source
 * missing) or sees something else (bind source is a different directory),
 * the host and relay disagree and the check fails closed.
 *
 * If the relay isn't containerized at all (no `/.dockerenv`), `docker
 * compose` runs directly on the host and congruence holds by construction
 * — nothing to probe.
 */
async function checkAppsRootMountCongruence(): Promise<PreflightCheck> {
  const name = "apps_root_mount_congruence";
  const appsDir = env.APPS_DIR;

  try {
    await access("/.dockerenv");
  } catch {
    return {
      name,
      passed: true,
      message:
        "Relay is not running inside a container (no /.dockerenv found); " +
        "docker compose runs directly on the host, so the host's and the " +
        `relay's views of ${appsDir} are the same directory by construction.`,
      critical: true,
    };
  }

  const markerPath = join(appsDir, MOUNT_PROBE_FILENAME);
  const token = randomUUID();

  try {
    await writeFile(markerPath, token, "utf-8");

    const image = await discoverRelayImage();
    if (!image) {
      return {
        name,
        passed: false,
        message:
          `Could not determine the relay's own docker image (tried ` +
          `"docker inspect ${hostname()}" and "docker inspect agent-relay"). ` +
          `Cannot verify that the host's view of ${appsDir} is the same ` +
          `directory the relay sees, so refusing to proceed (fail closed) — ` +
          `an undetected mismatch silently mounts empty directories over ` +
          `deployed apps' config files (2026-07-15 incident class). ` +
          `Diagnose with \`docker inspect <relay-container>\` on the docker ` +
          `host, or run the relay container named "agent-relay".`,
        critical: true,
      };
    }

    const probe = await runExec(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,source=${appsDir},target=/probe,readonly`,
        "--entrypoint",
        "cat",
        image,
        `/probe/${MOUNT_PROBE_FILENAME}`,
      ],
      appsDir,
    );

    const fixHint =
      `Fix: create a host symlink \`${appsDir} -> <real apps dir>\` (the ` +
      `real directory is whatever is bind-mounted at ${appsDir} in the ` +
      `relay's own compose file). Left unfixed, every file bind-mount of a ` +
      `deployed app is silently auto-created by docker as an empty ` +
      `directory on the host while deploys report success (2026-07-15 ` +
      `incident class).`;

    if (probe.exitCode !== 0) {
      const stderr = probe.stderr.toLowerCase();
      const missingSource =
        stderr.includes("bind source path does not exist") ||
        stderr.includes("no such file or directory");
      if (missingSource) {
        return {
          name,
          passed: false,
          message:
            `Host ${appsDir} does not exist on the docker host. The daemon ` +
            `resolves compose bind-mount sources against the HOST ` +
            `filesystem, not the relay container's view. ${fixHint} ` +
            `Docker error: ${probe.stderr.trim()}`,
          critical: true,
        };
      }
      return {
        name,
        passed: false,
        message: `Apps-root mount congruence probe failed unexpectedly: ${probe.stderr.trim() || probe.stdout.trim()}`,
        critical: true,
      };
    }

    const seen = probe.stdout.trim();
    if (seen !== token) {
      return {
        name,
        passed: false,
        message:
          `Host ${appsDir} exists but is NOT the same directory the relay ` +
          `sees (mount probe token mismatch). ${fixHint}`,
        critical: true,
      };
    }

    return {
      name,
      passed: true,
      message: `Host and relay agree on ${appsDir} (mount congruence probe round-tripped)`,
      critical: true,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      message: `Apps-root mount congruence check failed: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
    };
  } finally {
    await unlink(markerPath).catch(() => {});
  }
}

/**
 * The relay's own container id equals its hostname (docker default), so
 * `docker inspect <hostname>` finds it directly. Fallback to the
 * `agent-relay` container_name convention used by every generated prod
 * compose file, in case hostname resolution is unavailable for some
 * reason. Both candidates come from a trusted source (docker daemon /
 * our own naming convention) but are still passed as a single execFile
 * argv element — never shell-interpolated.
 */
async function discoverRelayImage(): Promise<string | undefined> {
  const candidates = [hostname(), "agent-relay"];
  for (const candidate of candidates) {
    const result = await runExec(
      "docker",
      ["inspect", "--format", "{{.Config.Image}}", candidate],
      env.APPS_DIR,
    );
    const image = result.stdout.trim();
    if (result.exitCode === 0 && image.length > 0) {
      return image;
    }
  }
  return undefined;
}

/**
 * Same incident class as checkAppsRootMountCongruence, but scoped to a
 * single app's compose file: `--mount type=bind` (unlike `-v`) does not
 * auto-create a missing host source when the compose file's own bind
 * paths are missing — some other tooling might, so this checks existence
 * from the relay's own filesystem view too, which is what post-pull
 * placement buys us (a `.relay.yml`/compose fix landed in the same
 * commit as an app's new bind-mount path is validated against the
 * FRESHLY pulled tree).
 *
 * We can't know whether a source is meant to be a file or a directory
 * from the compose file alone, so existence — not type — is the
 * contract enforced here.
 */
async function checkComposeBindMountSourcesExist(
  appDir: string,
  composeFile: string,
): Promise<PreflightCheck> {
  const name = "compose_bind_mount_sources_exist";
  const path = join(appDir, composeFile);

  let content: string;
  try {
    content = await readFile(path, "utf-8");
  } catch (err) {
    return {
      name,
      passed: false,
      message: `Could not read ${composeFile}: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
    };
  }

  let doc: unknown;
  try {
    doc = yaml.load(content);
  } catch (err) {
    return {
      name,
      passed: false,
      message: `Could not parse ${composeFile} as YAML: ${err instanceof Error ? err.message : String(err)}`,
      critical: true,
    };
  }

  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return {
      name,
      passed: false,
      message: `${composeFile} does not contain a YAML mapping`,
      critical: true,
    };
  }

  const sources = collectBindMountSources(doc as Record<string, unknown>);
  // Mirrors the containment style in config/relay.ts's
  // assertComposeFileContained: `startsWith(appsDir + sep)` (not just
  // `appsDir`) avoids a sibling-name prefix false-positive.
  const appsDir = resolve(env.APPS_DIR);

  const toCheck: string[] = [];
  const skipped: string[] = [];

  for (const src of sources) {
    if (src.includes("${")) {
      skipped.push(`${src} (unresolved \${...} interpolation)`);
      continue;
    }
    if (isAbsolute(src)) {
      const resolved = resolve(src);
      const contained = resolved === appsDir || resolved.startsWith(appsDir + sep);
      if (!contained) {
        skipped.push(`${src} (absolute, outside APPS_DIR)`);
        continue;
      }
      toCheck.push(resolved);
    } else {
      toCheck.push(resolve(appDir, src));
    }
  }

  const missing: string[] = [];
  for (const resolved of toCheck) {
    try {
      await stat(resolved);
    } catch {
      missing.push(resolved);
    }
  }

  const skippedNote = skipped.length ? ` Skipped (not checked): ${skipped.join(", ")}.` : "";

  if (missing.length > 0) {
    return {
      name,
      passed: false,
      message:
        `Missing compose bind-mount source path(s) referenced in ` +
        `${composeFile}: ${missing.join(", ")}. The docker daemon resolves ` +
        `compose bind-mount sources against the HOST filesystem; a missing ` +
        `source is silently auto-created by docker as an empty directory on ` +
        `the host, masking what should have been real app config ` +
        `(2026-07-15 incident class).${skippedNote}`,
      critical: true,
    };
  }

  return {
    name,
    passed: true,
    message: `All ${toCheck.length} compose bind-mount source(s) exist.${skippedNote}`,
    critical: true,
  };
}

/**
 * Collects host-side bind-mount source paths from a parsed compose
 * document: `services.*.volumes` (short `SRC:DST[:MODE]` syntax where
 * SRC looks like a path, and long `type: bind` syntax), plus top-level
 * `configs`/`secrets` entries with a `file:` attribute. Named volumes
 * (short syntax with a bare name, no `./`, `../`, or `/` prefix, and no
 * `${...}` interpolation) are ignored silently — they have no host
 * source to check.
 */
function collectBindMountSources(doc: Record<string, unknown>): string[] {
  const sources: string[] = [];

  const services = doc.services;
  if (services && typeof services === "object") {
    for (const svc of Object.values(services as Record<string, unknown>)) {
      if (!svc || typeof svc !== "object") continue;
      const volumes = (svc as Record<string, unknown>).volumes;
      if (!Array.isArray(volumes)) continue;
      for (const vol of volumes) {
        if (typeof vol === "string") {
          const src = parseShortVolumeSource(vol);
          if (src !== undefined) sources.push(src);
        } else if (vol && typeof vol === "object") {
          const v = vol as Record<string, unknown>;
          if (v.type === "bind" && typeof v.source === "string") {
            sources.push(v.source);
          }
        }
      }
    }
  }

  for (const topKey of ["configs", "secrets"] as const) {
    const section = doc[topKey];
    if (section && typeof section === "object") {
      for (const entry of Object.values(section as Record<string, unknown>)) {
        if (entry && typeof entry === "object") {
          const file = (entry as Record<string, unknown>).file;
          if (typeof file === "string") sources.push(file);
        }
      }
    }
  }

  return sources;
}

function parseShortVolumeSource(vol: string): string | undefined {
  const parts = vol.split(":");
  if (parts.length < 2) return undefined; // anonymous volume target, no source
  const src = parts[0]!;
  const looksLikePath = src.startsWith("./") || src.startsWith("../") || src.startsWith("/");
  const hasInterpolation = src.includes("${");
  if (looksLikePath || hasInterpolation) return src;
  return undefined; // named volume — no host source
}
