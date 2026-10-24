import { readFile, writeFile, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import * as yaml from "js-yaml";
import { env } from "../config/env.js";
import { getRelayRevision } from "../config/version.js";
import {
  acquireOperationLock,
  DeployConflictError,
  getActiveOperation,
  isOperationLocked,
} from "./engine.js";
import { runExec } from "./exec.js";

export { DeployConflictError, acquireOperationLock, getActiveOperation, isOperationLocked };

export const RELAY_IMAGE_REPO = "ghcr.io/lannguyensi/agent-relay";

const ALLOWED_TAG_REGEX = /^(?:latest|main-[0-9a-f]{7,40})$/;
const COMPOSE_PROJECT_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const COMPOSE_SERVICE_REGEX = /^[a-zA-Z0-9._-]+$/;

/**Default grace period (ms) to keep the operation lock held after spawning the helper container.*/
const DEFAULT_POST_SPAWN_LOCK_MS = 15_000;

export class SelfUpdateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateValidationError";
  }
}

export class SelfUpdateRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateRefusedError";
  }
}

export class SelfUpdateExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfUpdateExecutionError";
  }
}

export interface ComposeSelfConfig {
  containerId: string;
  project: string;
  workingDir: string;
  configFiles: string[];
  service: string;
  configuredImage: string;
}

export interface SelfUpdateStateRecord {
  status: "in_progress" | "succeeded" | "failed" | "refused";
  tag: string;
  targetImage: string;
  digest: string | null;
  previousRevision: string;
  targetRevision: string | null;
  requestedAt: string;
  updatedAt: string;
  completedAt?: string;
  helperContainerName?: string;
  error?: string;
  recovery: string;
}

export interface SelfUpdateAcceptedResult {
  status: "accepted";
  tag: string;
  targetImage: string;
  digest: string;
  previousRevision: string;
  targetRevision: string;
  recovery: string;
  /** Internal callback invoked by the HTTP route after the 202 response is returned. */
  launchHelper: () => Promise<void>;
}

export const SELF_UPDATE_RECOVERY_GUIDANCE =
  "If the new relay container does not become healthy, recover via deploy-panel's SSH Update Relay Image flow (POST /api/servers/:id/update-relay-image) or run `docker compose pull && docker compose up -d` in the relay directory on the host.";

export function logSelfUpdateEvent(
  event: "requested" | "refused" | "accepted" | "helper_spawned" | "failed" | "reconciled",
  details: Record<string, unknown>,
): void {
  const payload = JSON.stringify({
    ts: new Date().toISOString(),
    event,
    ...details,
  });
  if (event === "failed" || event === "refused") {
    console.error(`[self-update] ${payload}`);
  } else {
    console.log(`[self-update] ${payload}`);
  }
}

function selfUpdateStatePath(): string {
  return join(env.APPS_DIR, ".relay-self-update.json");
}

export async function writeSelfUpdateState(record: SelfUpdateStateRecord): Promise<void> {
  const path = selfUpdateStatePath();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(record, null, 2), "utf-8");
}

export async function readSelfUpdateState(): Promise<SelfUpdateStateRecord | null> {
  try {
    const raw = await readFile(selfUpdateStatePath(), "utf-8");
    return JSON.parse(raw) as SelfUpdateStateRecord;
  } catch {
    return null;
  }
}

/**
 * Reconciles a persisted `in_progress` self-update state record against the
 * currently running relay revision (`RELAY_REVISION`). When the running
 * container's revision matches `targetRevision`, marks the record `succeeded`.
 */
export async function reconcileSelfUpdateState(): Promise<SelfUpdateStateRecord | null> {
  const record = await readSelfUpdateState();
  if (!record) return null;
  if (record.status === "in_progress") {
    const currentRevision = getRelayRevision();
    if (
      currentRevision !== "unknown" &&
      record.targetRevision &&
      record.targetRevision !== "unknown" &&
      currentRevision === record.targetRevision
    ) {
      const now = new Date().toISOString();
      const updated: SelfUpdateStateRecord = {
        ...record,
        status: "succeeded",
        updatedAt: now,
        completedAt: now,
      };
      await writeSelfUpdateState(updated).catch(() => {});
      logSelfUpdateEvent("reconciled", {
        status: "succeeded",
        previousRevision: record.previousRevision,
        targetRevision: record.targetRevision,
        currentRevision,
      });
      return updated;
    }
  }
  return record;
}

/**
 * Validates the optional `tag` field for `POST /api/self-update`.
 * Only `"latest"` (default when omitted) or `"main-<7..40 lowercase hex>"`
 * are permitted.
 */
export function validateSelfUpdateTag(rawTag: unknown): string {
  if (rawTag === undefined) return "latest";
  if (typeof rawTag !== "string" || !ALLOWED_TAG_REGEX.test(rawTag)) {
    throw new SelfUpdateValidationError(
      "Invalid tag: must be 'latest' or 'main-<hex sha>' (7-40 lowercase hex characters)",
    );
  }
  return rawTag;
}

/**
 * Discovers the relay container's compose project, working directory,
 * compose config files, and service name from its own Docker container labels,
 * and verifies that the compose file defines an image-based (not build-based)
 * relay service.
 */
export async function discoverSelfComposeConfig(
  candidates: readonly string[] = [hostname(), "agent-relay"],
): Promise<ComposeSelfConfig> {
  let labels: Record<string, string> | null = null;
  let matchedCandidate = "";

  for (const candidate of candidates) {
    if (!candidate || candidate.includes("\0")) continue;
    const inspectRes = await runExec(
      "docker",
      ["inspect", "--format", "{{json .Config.Labels}}", candidate],
      env.APPS_DIR,
    );
    const trimmed = inspectRes.stdout.trim();
    if (inspectRes.exitCode === 0 && trimmed.length > 0 && trimmed !== "null") {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          labels = parsed as Record<string, string>;
          matchedCandidate = candidate;
          break;
        }
      } catch {
        // Continue to next candidate
      }
    }
  }

  if (!labels) {
    throw new SelfUpdateRefusedError(
      `Could not inspect the relay container's Docker labels (tried ${candidates.join(", ")}). ` +
        `Self-update requires a containerized relay launched via docker compose. ${SELF_UPDATE_RECOVERY_GUIDANCE}`,
    );
  }

  const project = labels["com.docker.compose.project"]?.trim() ?? "";
  const workingDirRaw = labels["com.docker.compose.project.working_dir"]?.trim() ?? "";
  const configFilesRaw = labels["com.docker.compose.project.config_files"]?.trim() ?? "";
  const serviceRaw = labels["com.docker.compose.service"]?.trim();
  const service = serviceRaw && serviceRaw.length > 0 ? serviceRaw : "relay";

  if (!project || !COMPOSE_PROJECT_REGEX.test(project)) {
    throw new SelfUpdateRefusedError(
      "Missing or invalid com.docker.compose.project label on the relay container; refusing to guess compose project.",
    );
  }

  if (!workingDirRaw || !isAbsolute(workingDirRaw) || workingDirRaw.includes("\0")) {
    throw new SelfUpdateRefusedError(
      "Missing or non-absolute com.docker.compose.project.working_dir label on the relay container; refusing to guess working directory.",
    );
  }

  if (!configFilesRaw || configFilesRaw.includes("\0")) {
    throw new SelfUpdateRefusedError(
      "Missing com.docker.compose.project.config_files label on the relay container; refusing to guess compose file path.",
    );
  }

  if (!COMPOSE_SERVICE_REGEX.test(service)) {
    throw new SelfUpdateRefusedError(
      `Invalid com.docker.compose.service label '${service}' on the relay container.`,
    );
  }

  const resolvedWorkingDir = resolve(workingDirRaw);
  const rawFiles = configFilesRaw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (rawFiles.length === 0) {
    throw new SelfUpdateRefusedError(
      "Empty com.docker.compose.project.config_files label on the relay container.",
    );
  }

  const configFiles: string[] = [];
  for (const fileEntry of rawFiles) {
    const resolvedFile = resolve(resolvedWorkingDir, fileEntry);
    if (
      resolvedFile !== resolvedWorkingDir &&
      !resolvedFile.startsWith(resolvedWorkingDir + sep)
    ) {
      throw new SelfUpdateRefusedError(
        `Compose config file '${fileEntry}' resolves outside working directory '${resolvedWorkingDir}'.`,
      );
    }
    configFiles.push(resolvedFile);
  }

  // Read and inspect the compose file(s) to confirm the relay service is image-based, not build-based.
  let foundService = false;
  let hasBuild = false;
  let configuredImage = "";

  for (const filePath of configFiles) {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      throw new SelfUpdateRefusedError(
        `Cannot read relay compose file '${filePath}' from inside the relay container (${err instanceof Error ? err.message : String(err)}). ` +
          `Mount the relay compose directory or recover via SSH. ${SELF_UPDATE_RECOVERY_GUIDANCE}`,
      );
    }

    let doc: unknown;
    try {
      doc = yaml.load(content);
    } catch (err) {
      throw new SelfUpdateRefusedError(
        `Invalid YAML in relay compose file '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
      throw new SelfUpdateRefusedError(
        `Compose file '${filePath}' does not contain a valid YAML mapping.`,
      );
    }

    const services = (doc as Record<string, unknown>).services;
    if (!services || typeof services !== "object" || Array.isArray(services)) {
      continue;
    }

    const svcDef = (services as Record<string, unknown>)[service];
    if (!svcDef || typeof svcDef !== "object" || Array.isArray(svcDef)) {
      continue;
    }

    foundService = true;
    const svcRecord = svcDef as Record<string, unknown>;
    if (svcRecord.build !== undefined && svcRecord.build !== null) {
      hasBuild = true;
    }
    if (typeof svcRecord.image === "string" && svcRecord.image.trim().length > 0) {
      configuredImage = svcRecord.image.trim();
    }
  }

  if (!foundService) {
    throw new SelfUpdateRefusedError(
      `Service '${service}' was not found in compose file(s) ${configFiles.join(", ")}.`,
    );
  }

  if (hasBuild) {
    throw new SelfUpdateRefusedError(
      `Relay service '${service}' uses a build-based compose configuration ('build:' is set). ` +
        `Self-update only supports prebuilt GHCR image installations. ${SELF_UPDATE_RECOVERY_GUIDANCE}`,
    );
  }

  if (!configuredImage) {
    throw new SelfUpdateRefusedError(
      `Relay service '${service}' does not declare an 'image:' in compose file(s) ${configFiles.join(", ")}.`,
    );
  }

  return {
    containerId: matchedCandidate,
    project,
    workingDir: resolvedWorkingDir,
    configFiles,
    service,
    configuredImage,
  };
}

interface ImageInspectEntry {
  Id?: string;
  RepoDigests?: string[];
  Config?: {
    Labels?: Record<string, string>;
  };
}

function parseInspectedImage(stdout: string): { digest: string; revision: string } {
  const trimmed = stdout.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new SelfUpdateExecutionError("Failed to parse docker image inspect output as JSON");
  }

  const entry: ImageInspectEntry | undefined = Array.isArray(parsed)
    ? (parsed[0] as ImageInspectEntry | undefined)
    : (parsed as ImageInspectEntry | undefined);

  if (!entry || typeof entry !== "object") {
    throw new SelfUpdateExecutionError("Docker image inspect returned an empty result");
  }

  const repoDigest = Array.isArray(entry.RepoDigests) && typeof entry.RepoDigests[0] === "string"
    ? entry.RepoDigests[0]
    : "";
  const atIndex = repoDigest.indexOf("@");
  const digest =
    atIndex !== -1
      ? repoDigest.slice(atIndex + 1)
      : repoDigest || (typeof entry.Id === "string" ? entry.Id : "unknown");

  const rawRevision = entry.Config?.Labels?.["org.opencontainers.image.revision"]?.trim();
  const revision = rawRevision && rawRevision.length > 0 ? rawRevision : "unknown";

  return { digest, revision };
}

export interface PrepareSelfUpdateOptions {
  tag?: unknown;
  candidates?: readonly string[];
  postSpawnLockMs?: number;
}

/**
 * Runs all synchronous/pre-202 self-update steps under the shared deploy lock:
 * 1. Validates `tag` (`latest` or `main-<hex sha>`).
 * 2. Acquires the shared operation lock (throws `DeployConflictError` -> 409 if busy).
 * 3. Discovers compose labels and verifies the relay service is image-based (throws `SelfUpdateRefusedError` -> 422).
 * 4. Pulls `ghcr.io/lannguyensi/agent-relay:<tag>` and inspects digest + `org.opencontainers.image.revision`.
 * 5. Writes `.relay-self-update.json` (`in_progress`) and returns the `202` payload plus `launchHelper()`.
 */
export async function prepareSelfUpdate(
  options: PrepareSelfUpdateOptions = {},
): Promise<SelfUpdateAcceptedResult> {
  const previousRevision = getRelayRevision();

  let tag: string;
  try {
    tag = validateSelfUpdateTag(options.tag);
  } catch (err) {
    logSelfUpdateEvent("refused", {
      reason: "invalid_tag",
      rawTag: typeof options.tag === "string" ? options.tag.slice(0, 64) : typeof options.tag,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  const targetImage = `${RELAY_IMAGE_REPO}:${tag}`;
  logSelfUpdateEvent("requested", { tag, targetImage, previousRevision });

  let releaseLock: () => void;
  try {
    releaseLock = acquireOperationLock("self-update", targetImage);
  } catch (err) {
    logSelfUpdateEvent("refused", {
      reason: "lock_conflict",
      tag,
      targetImage,
      activeOperation: getActiveOperation(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  try {
    const compose = await discoverSelfComposeConfig(options.candidates);

    const pullRes = await runExec("docker", ["pull", targetImage], compose.workingDir);
    if (pullRes.exitCode !== 0) {
      const detail = (pullRes.stderr || pullRes.stdout).trim() || `exit code ${pullRes.exitCode}`;
      throw new SelfUpdateExecutionError(`Failed to pull ${targetImage}: ${detail}`);
    }

    const inspectRes = await runExec(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", targetImage],
      compose.workingDir,
    );
    if (inspectRes.exitCode !== 0) {
      const detail = (inspectRes.stderr || inspectRes.stdout).trim() || `exit code ${inspectRes.exitCode}`;
      throw new SelfUpdateExecutionError(`Failed to inspect pulled image ${targetImage}: ${detail}`);
    }

    const { digest, revision: targetRevision } = parseInspectedImage(inspectRes.stdout);
    const now = new Date().toISOString();
    const helperContainerName = `agent-relay-self-update-${Date.now()}`;

    const stateRecord: SelfUpdateStateRecord = {
      status: "in_progress",
      tag,
      targetImage,
      digest,
      previousRevision,
      targetRevision,
      requestedAt: now,
      updatedAt: now,
      helperContainerName,
      recovery: SELF_UPDATE_RECOVERY_GUIDANCE,
    };
    await writeSelfUpdateState(stateRecord);

    logSelfUpdateEvent("accepted", {
      tag,
      targetImage,
      digest,
      previousRevision,
      targetRevision,
      project: compose.project,
      workingDir: compose.workingDir,
      configFiles: compose.configFiles,
      service: compose.service,
      helperContainerName,
    });

    const postSpawnLockMs = options.postSpawnLockMs ?? DEFAULT_POST_SPAWN_LOCK_MS;
    let launched = false;

    const launchHelper = async (): Promise<void> => {
      if (launched) return;
      launched = true;
      try {
        const composeFileArgs = compose.configFiles.flatMap((file) => ["-f", file]);
        const spawnArgs = [
          "run",
          "-d",
          "--rm",
          "--name",
          helperContainerName,
          "-v",
          "/var/run/docker.sock:/var/run/docker.sock",
          "-v",
          `${compose.workingDir}:${compose.workingDir}:ro`,
          "-w",
          compose.workingDir,
          "--entrypoint",
          "docker",
          targetImage,
          "compose",
          "-p",
          compose.project,
          ...composeFileArgs,
          "up",
          "-d",
          compose.service,
        ];

        const spawnRes = await runExec("docker", spawnArgs, compose.workingDir);
        if (spawnRes.exitCode !== 0) {
          const errMsg =
            (spawnRes.stderr || spawnRes.stdout).trim() ||
            `Helper container exited with code ${spawnRes.exitCode}`;
          const failedAt = new Date().toISOString();
          await writeSelfUpdateState({
            ...stateRecord,
            status: "failed",
            updatedAt: failedAt,
            completedAt: failedAt,
            error: errMsg,
          }).catch(() => {});
          logSelfUpdateEvent("failed", {
            phase: "spawn_helper",
            tag,
            targetImage,
            helperContainerName,
            error: errMsg,
          });
          releaseLock();
          return;
        }

        logSelfUpdateEvent("helper_spawned", {
          tag,
          targetImage,
          digest,
          targetRevision,
          helperContainerName,
          helperContainerId: spawnRes.stdout.trim(),
        });

        if (postSpawnLockMs <= 0) {
          releaseLock();
        } else {
          const timer = setTimeout(() => {
            releaseLock();
          }, postSpawnLockMs);
          timer.unref?.();
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const failedAt = new Date().toISOString();
        await writeSelfUpdateState({
          ...stateRecord,
          status: "failed",
          updatedAt: failedAt,
          completedAt: failedAt,
          error: errMsg,
        }).catch(() => {});
        logSelfUpdateEvent("failed", {
          phase: "spawn_helper",
          tag,
          targetImage,
          helperContainerName,
          error: errMsg,
        });
        releaseLock();
      }
    };

    return {
      status: "accepted",
      tag,
      targetImage,
      digest,
      previousRevision,
      targetRevision,
      recovery: SELF_UPDATE_RECOVERY_GUIDANCE,
      launchHelper,
    };
  } catch (err) {
    releaseLock();
    const errMsg = err instanceof Error ? err.message : String(err);
    const now = new Date().toISOString();
    if (err instanceof SelfUpdateRefusedError) {
      await writeSelfUpdateState({
        status: "refused",
        tag,
        targetImage,
        digest: null,
        previousRevision,
        targetRevision: null,
        requestedAt: now,
        updatedAt: now,
        completedAt: now,
        error: errMsg,
        recovery: SELF_UPDATE_RECOVERY_GUIDANCE,
      }).catch(() => {});
      logSelfUpdateEvent("refused", {
        reason: "compose_refused",
        tag,
        targetImage,
        error: errMsg,
      });
    } else {
      await writeSelfUpdateState({
        status: "failed",
        tag,
        targetImage,
        digest: null,
        previousRevision,
        targetRevision: null,
        requestedAt: now,
        updatedAt: now,
        completedAt: now,
        error: errMsg,
        recovery: SELF_UPDATE_RECOVERY_GUIDANCE,
      }).catch(() => {});
      logSelfUpdateEvent("failed", {
        phase: "prepare",
        tag,
        targetImage,
        error: errMsg,
      });
    }
    throw err;
  }
}
