import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./exec.js", () => ({
  runExec: vi.fn(),
  runShell: vi.fn(),
}));

import { runExec, runShell } from "./exec.js";
import {
  deploy,
  DeployConflictError,
  resetOperationLockForTests,
} from "./engine.js";
import {
  validateSelfUpdateTag,
  discoverSelfComposeConfig,
  prepareSelfUpdate,
  readSelfUpdateState,
  reconcileSelfUpdateState,
  SelfUpdateValidationError,
  SelfUpdateRefusedError,
  SelfUpdateExecutionError,
} from "./self-update.js";
import * as apps from "../services/apps.js";
import { env } from "../config/env.js";

const mockRunExec = vi.mocked(runExec);
const mockRunShell = vi.mocked(runShell);

const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";
const DIGEST = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

describe("self-update engine and shared concurrency lock", () => {
  let tempDir: string;
  let composeDir: string;
  let composeFile: string;
  let originalAppsDir: string;
  let originalRelayRevision: string | undefined;

  beforeEach(async () => {
    vi.resetAllMocks();
    resetOperationLockForTests();

    tempDir = await mkdtemp(join(tmpdir(), "relay-self-update-test-"));
    composeDir = join(tempDir, "relay-compose");
    await mkdtemp(join(tempDir, "apps-"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(composeDir, { recursive: true });
    composeFile = join(composeDir, "docker-compose.yml");

    await writeFile(
      composeFile,
      [
        "services:",
        "  relay:",
        "    image: ghcr.io/lannguyensi/agent-relay:latest",
        "    restart: unless-stopped",
      ].join("\n"),
      "utf-8",
    );

    originalAppsDir = env.APPS_DIR;
    (env as { APPS_DIR: string }).APPS_DIR = tempDir;
    originalRelayRevision = process.env.RELAY_REVISION;
    process.env.RELAY_REVISION = OLD_SHA;
  });

  afterEach(async () => {
    resetOperationLockForTests();
    (env as { APPS_DIR: string }).APPS_DIR = originalAppsDir;
    if (originalRelayRevision === undefined) {
      delete process.env.RELAY_REVISION;
    } else {
      process.env.RELAY_REVISION = originalRelayRevision;
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("validateSelfUpdateTag", () => {
    it("defaults omitted or undefined tag to 'latest' and accepts 'latest' or 'main-<7..40 hex>'", () => {
      expect(validateSelfUpdateTag(undefined)).toBe("latest");
      expect(validateSelfUpdateTag("latest")).toBe("latest");
      expect(validateSelfUpdateTag("main-abcdef1")).toBe("main-abcdef1");
      expect(validateSelfUpdateTag(`main-${NEW_SHA}`)).toBe(`main-${NEW_SHA}`);
    });

    it("rejects empty, non-string, arbitrary, uppercase, or injection-shaped tags", () => {
      const invalidInputs: unknown[] = [
        "",
        "v1.0.0",
        "main-123456",
        "main-ABCDEF1",
        `main-${NEW_SHA}a`,
        "latest; rm -rf /",
        "$(id)",
        "`uname -a`",
        "--help",
        null,
        123,
        { tag: "latest" },
      ];
      for (const input of invalidInputs) {
        expect(() => validateSelfUpdateTag(input)).toThrow(SelfUpdateValidationError);
      }
    });
  });

  describe("discoverSelfComposeConfig", () => {
    it("discovers compose project, workingDir, configFiles, and default service 'relay' from container labels", async () => {
      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": composeDir,
          "com.docker.compose.project.config_files": "docker-compose.yml",
        }),
        stderr: "",
        exitCode: 0,
      });

      const cfg = await discoverSelfComposeConfig(["relay-container"]);
      expect(cfg).toEqual({
        containerId: "relay-container",
        project: "agent-relay",
        workingDir: composeDir,
        configFiles: [composeFile],
        service: "relay",
        configuredImage: "ghcr.io/lannguyensi/agent-relay:latest",
      });
    });

    it("refuses when container labels cannot be inspected or required labels are missing", async () => {
      mockRunExec.mockResolvedValue({ stdout: "", stderr: "No such container", exitCode: 1 });
      await expect(discoverSelfComposeConfig(["missing"])).rejects.toThrow(SelfUpdateRefusedError);

      // Missing working_dir
      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.config_files": composeFile,
        }),
        stderr: "",
        exitCode: 0,
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(SelfUpdateRefusedError);

      // Relative working_dir
      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": "relative/dir",
          "com.docker.compose.project.config_files": "docker-compose.yml",
        }),
        stderr: "",
        exitCode: 0,
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(SelfUpdateRefusedError);
    });

    it("refuses when config_files escapes working_dir (path traversal or sibling prefix)", async () => {
      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": composeDir,
          "com.docker.compose.project.config_files": "../outside.yml",
        }),
        stderr: "",
        exitCode: 0,
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(SelfUpdateRefusedError);

      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": composeDir,
          "com.docker.compose.project.config_files": `${composeDir}-sibling/docker-compose.yml`,
        }),
        stderr: "",
        exitCode: 0,
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(SelfUpdateRefusedError);
    });

    it("refuses when the compose service is build-based or omits 'image:'", async () => {
      await writeFile(
        composeFile,
        [
          "services:",
          "  relay:",
          "    build: .",
          "    image: ghcr.io/lannguyensi/agent-relay:latest",
        ].join("\n"),
        "utf-8",
      );

      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": composeDir,
          "com.docker.compose.project.config_files": composeFile,
          "com.docker.compose.service": "relay",
        }),
        stderr: "",
        exitCode: 0,
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
        /build-based compose configuration/i,
      );

      // Missing image:
      await writeFile(
        composeFile,
        ["services:", "  relay:", "    restart: always"].join("\n"),
        "utf-8",
      );
      mockRunExec.mockResolvedValueOnce({
        stdout: JSON.stringify({
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": composeDir,
          "com.docker.compose.project.config_files": composeFile,
        }),
        stderr: "",
        exitCode: 0,
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
        /does not declare an 'image:'/i,
      );
    });
  });

  describe("prepareSelfUpdate, helper container launch, and state reconciliation", () => {
    function setupHappyDockerMocks() {
      mockRunExec.mockImplementation(async (cmd, args) => {
        if (cmd === "docker" && args[0] === "inspect") {
          return {
            stdout: JSON.stringify({
              "com.docker.compose.project": "agent-relay",
              "com.docker.compose.project.working_dir": composeDir,
              "com.docker.compose.project.config_files": composeFile,
              "com.docker.compose.service": "relay",
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "docker" && args[0] === "pull") {
          return { stdout: "Pulled", stderr: "", exitCode: 0 };
        }
        if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
          return {
            stdout: JSON.stringify([
              {
                Id: "sha256:1234",
                RepoDigests: [`ghcr.io/lannguyensi/agent-relay@${DIGEST}`],
                Config: {
                  Labels: {
                    "org.opencontainers.image.revision": NEW_SHA,
                  },
                },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "docker" && args[0] === "run") {
          return { stdout: "helper-container-id-123\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      });
    }

    it("pulls the target image, inspects digest & revision, writes .relay-self-update.json, spawns detached helper container via runExec argv array, and reconciles on restart", async () => {
      setupHappyDockerMocks();

      const accepted = await prepareSelfUpdate({
        tag: "latest",
        candidates: ["agent-relay"],
        postSpawnLockMs: 0,
      });

      expect(accepted).toMatchObject({
        status: "accepted",
        tag: "latest",
        targetImage: "ghcr.io/lannguyensi/agent-relay:latest",
        digest: DIGEST,
        previousRevision: OLD_SHA,
        targetRevision: NEW_SHA,
      });

      const inProgressState = await readSelfUpdateState();
      expect(inProgressState).toMatchObject({
        status: "in_progress",
        tag: "latest",
        targetImage: "ghcr.io/lannguyensi/agent-relay:latest",
        digest: DIGEST,
        previousRevision: OLD_SHA,
        targetRevision: NEW_SHA,
      });

      await accepted.launchHelper();

      expect(mockRunShell).not.toHaveBeenCalled();
      const runCall = mockRunExec.mock.calls.find(
        ([cmd, args]) => cmd === "docker" && args[0] === "run",
      );
      expect(runCall).toBeDefined();
      expect(runCall?.[1]).toEqual([
        "run",
        "-d",
        "--rm",
        "--name",
        expect.stringMatching(/^agent-relay-self-update-\d+$/),
        "-v",
        "/var/run/docker.sock:/var/run/docker.sock",
        "-v",
        `${composeDir}:${composeDir}:ro`,
        "-w",
        composeDir,
        "--entrypoint",
        "docker",
        "ghcr.io/lannguyensi/agent-relay:latest",
        "compose",
        "-p",
        "agent-relay",
        "-f",
        composeFile,
        "up",
        "-d",
        "relay",
      ]);

      // Simulate restart onto the new revision and reconcile state
      process.env.RELAY_REVISION = NEW_SHA;
      const reconciled = await reconcileSelfUpdateState();
      expect(reconciled?.status).toBe("succeeded");
      expect(reconciled?.completedAt).toBeDefined();
    });

    it("records failed state and releases the lock if docker pull fails", async () => {
      mockRunExec.mockImplementation(async (cmd, args) => {
        if (cmd === "docker" && args[0] === "inspect") {
          return {
            stdout: JSON.stringify({
              "com.docker.compose.project": "agent-relay",
              "com.docker.compose.project.working_dir": composeDir,
              "com.docker.compose.project.config_files": composeFile,
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "docker" && args[0] === "pull") {
          return { stdout: "", stderr: "manifest unknown", exitCode: 1 };
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"], postSpawnLockMs: 0 }),
      ).rejects.toThrow(SelfUpdateExecutionError);

      const state = await readSelfUpdateState();
      expect(state?.status).toBe("failed");
      expect(state?.error).toContain("manifest unknown");
      expect(apps.isOperationLocked()).toBe(false);
    });
  });

  describe("shared concurrency lock (both directions)", () => {
    it("refuses self-update with DeployConflictError while a deploy is active", async () => {
      let releaseDeployGate!: () => void;
      const deployGate = new Promise<void>((resolve) => {
        releaseDeployGate = resolve;
      });

      mockRunExec.mockImplementation(async (cmd, args) => {
        if (cmd === "git" && args.includes("rev-parse")) {
          await deployGate;
          return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      const inFlightDeploy = deploy({
        appDir: composeDir,
        config: {
          name: "demo",
          health: "/health",
          compose_file: "docker-compose.yml",
          pre_update: [],
          post_update: [],
          rollback: false,
          command: "echo ok",
        },
      });

      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"] }),
      ).rejects.toThrow(DeployConflictError);

      releaseDeployGate();
      await inFlightDeploy;
    });

    it("refuses self-update with DeployConflictError while a rollback is active", async () => {
      const appDir = join(tempDir, "demo");
      const { mkdir } = await import("node:fs/promises");
      await mkdir(appDir, { recursive: true });
      await writeFile(
        join(appDir, ".relay.yml"),
        "name: demo\nhealth: /health\ncompose_file: docker-compose.yml\n",
        "utf-8",
      );

      let releaseRollbackGate!: () => void;
      const rollbackGate = new Promise<void>((resolve) => {
        releaseRollbackGate = resolve;
      });

      mockRunExec.mockImplementation(async (cmd, args) => {
        if (cmd === "git" && args[0] === "rev-parse" && args[1] === "HEAD") {
          await rollbackGate;
          return { stdout: `${OLD_SHA}\n`, stderr: "", exitCode: 0 };
        }
        return { stdout: `${OLD_SHA}\n`, stderr: "", exitCode: 0 };
      });

      const inFlightRollback = apps.rollbackApp("demo").catch(() => null);

      // Give rollbackApp a microtask to acquire the lock and hit rollbackGate
      await new Promise((resolve) => setTimeout(resolve, 10));

      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"] }),
      ).rejects.toThrow(DeployConflictError);

      releaseRollbackGate();
      await inFlightRollback;
    });

    it("refuses deploy and rollback with DeployConflictError while a self-update holds the lock", async () => {
      mockRunExec.mockImplementation(async (cmd, args) => {
        if (cmd === "docker" && args[0] === "inspect") {
          return {
            stdout: JSON.stringify({
              "com.docker.compose.project": "agent-relay",
              "com.docker.compose.project.working_dir": composeDir,
              "com.docker.compose.project.config_files": composeFile,
            }),
            stderr: "",
            exitCode: 0,
          };
        }
        if (cmd === "docker" && args[0] === "pull") {
          return { stdout: "Pulled", stderr: "", exitCode: 0 };
        }
        if (cmd === "docker" && args[0] === "image" && args[1] === "inspect") {
          return {
            stdout: JSON.stringify([
              {
                RepoDigests: [`ghcr.io/lannguyensi/agent-relay@${DIGEST}`],
                Config: { Labels: { "org.opencontainers.image.revision": NEW_SHA } },
              },
            ]),
            stderr: "",
            exitCode: 0,
          };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      const accepted = await prepareSelfUpdate({
        tag: "latest",
        candidates: ["agent-relay"],
        postSpawnLockMs: 5000,
      });

      await expect(apps.deployApp("demo")).rejects.toThrow(DeployConflictError);
      await expect(apps.deployAppStreaming("demo")).rejects.toThrow(DeployConflictError);
      await expect(apps.rollbackApp("demo")).rejects.toThrow(DeployConflictError);

      await accepted.launchHelper();
      resetOperationLockForTests();
    });
  });
});
