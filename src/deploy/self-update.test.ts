import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
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
  writeSelfUpdateState,
  normalizeImageRef,
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
        "xlatest",
        "latest\n",
        "main-abcdef1\n",
        null,
        123,
        { tag: "latest" },
      ];
      for (const input of invalidInputs) {
        expect(() => validateSelfUpdateTag(input)).toThrow(SelfUpdateValidationError);
      }
    });
  });

  const RELAY_IMAGE = "ghcr.io/lannguyensi/agent-relay:latest";

  interface DockerMockOptions {
    labels?: Record<string, string> | null;
    image?: string;
    /** Compose file content keyed by host path; paths not listed are read from disk. */
    hostFiles?: Record<string, string>;
    pullError?: string;
    helperRunError?: string;
    targetRevision?: string;
    helperState?: { Status: string; ExitCode: number } | null;
    helperLogs?: string;
    oldHelperIds?: string;
  }

  function defaultLabels(): Record<string, string> {
    return {
      "com.docker.compose.project": "agent-relay",
      "com.docker.compose.project.working_dir": composeDir,
      "com.docker.compose.project.config_files": composeFile,
      "com.docker.compose.service": "relay",
    };
  }

  function mockDocker(opts: DockerMockOptions = {}) {
    const labels = opts.labels === undefined ? defaultLabels() : opts.labels;
    mockRunExec.mockImplementation(async (cmd, args) => {
      const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
      const fail = (stderr: string) => ({ stdout: "", stderr, exitCode: 1 });
      if (cmd !== "docker") return ok("ok");
      if (args[0] === "inspect" && args.includes("{{json .Config}}")) {
        if (labels === null) return fail("No such container");
        return ok(JSON.stringify({ Labels: labels, Image: opts.image ?? RELAY_IMAGE }));
      }
      if (args[0] === "inspect" && args.includes("{{json .State}}")) {
        return opts.helperState ? ok(JSON.stringify(opts.helperState)) : fail("No such container");
      }
      if (args[0] === "logs") return ok(opts.helperLogs ?? "");
      if (args[0] === "run" && args.includes("cat")) {
        const file = args[args.length - 1];
        if (opts.hostFiles && file in opts.hostFiles) return ok(opts.hostFiles[file]);
        try {
          return ok(await readFile(file, "utf-8"));
        } catch {
          return fail(`cat: can't open '${file}': No such file or directory`);
        }
      }
      if (args[0] === "ps") return ok(opts.oldHelperIds ?? "");
      if (args[0] === "rm") return ok("");
      if (args[0] === "pull") return opts.pullError ? fail(opts.pullError) : ok("Pulled");
      if (args[0] === "image" && args[1] === "inspect") {
        return ok(
          JSON.stringify([
            {
              Id: "sha256:1234",
              RepoDigests: [`ghcr.io/lannguyensi/agent-relay@${DIGEST}`],
              Config: {
                Labels: { "org.opencontainers.image.revision": opts.targetRevision ?? NEW_SHA },
              },
            },
          ]),
        );
      }
      if (args[0] === "run") {
        return opts.helperRunError ? fail(opts.helperRunError) : ok("helper-container-id-123\n");
      }
      return fail("unexpected command");
    });
  }

  describe("discoverSelfComposeConfig", () => {
    it("discovers compose project, workingDir, configFiles, and default service 'relay' from container labels", async () => {
      const labels = defaultLabels();
      delete labels["com.docker.compose.service"];
      labels["com.docker.compose.project.config_files"] = "docker-compose.yml";
      mockDocker({ labels });

      const cfg = await discoverSelfComposeConfig(["relay-container"]);
      expect(cfg).toEqual({
        containerId: "relay-container",
        project: "agent-relay",
        workingDir: composeDir,
        configFiles: [composeFile],
        service: "relay",
        configuredImage: RELAY_IMAGE,
      });
      const inspectCall = mockRunExec.mock.calls.find(([, args]) => args[0] === "inspect");
      expect(inspectCall?.[1]).toEqual([
        "inspect",
        "--type",
        "container",
        "--format",
        "{{json .Config}}",
        "relay-container",
      ]);
    });

    it("reads the compose file through the Docker daemon when the host path does not exist inside the relay container", async () => {
      const hostDir = "/opt/agent-relay";
      const hostFile = "/opt/agent-relay/docker-compose.yml";
      mockDocker({
        labels: {
          "com.docker.compose.project": "agent-relay",
          "com.docker.compose.project.working_dir": hostDir,
          "com.docker.compose.project.config_files": hostFile,
        },
        hostFiles: { [hostFile]: `services:\n  relay:\n    image: ${RELAY_IMAGE}\n` },
      });

      const cfg = await discoverSelfComposeConfig(["agent-relay"]);
      expect(cfg.configuredImage).toBe(RELAY_IMAGE);
      const catCall = mockRunExec.mock.calls.find(([, args]) => args.includes("cat"));
      expect(catCall?.[1]).toEqual([
        "run",
        "--rm",
        "--network",
        "none",
        "--mount",
        `type=bind,source=${hostDir},target=${hostDir},readonly`,
        "--entrypoint",
        "cat",
        RELAY_IMAGE,
        hostFile,
      ]);
    });

    it("refuses when the compose file cannot be read on the Docker host", async () => {
      mockDocker({
        labels: {
          ...defaultLabels(),
          "com.docker.compose.project.config_files": join(composeDir, "missing.yml"),
        },
      });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
        /Cannot read relay compose file .* on the Docker host/,
      );
    });

    it("refuses when the relay container cannot be inspected or reports no image", async () => {
      mockDocker({ labels: null });
      await expect(discoverSelfComposeConfig(["missing"])).rejects.toThrow(
        /Could not inspect the relay container's Docker labels/,
      );

      mockDocker({ image: "" });
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
        /Could not determine the relay container's own image/,
      );
    });

    const labelCases: Array<[string, Record<string, string | undefined>, RegExp]> = [
      ["missing project", { "com.docker.compose.project": undefined }, /invalid com\.docker\.compose\.project label/],
      ["option-shaped project", { "com.docker.compose.project": "-p" }, /invalid com\.docker\.compose\.project label/],
      ["missing working_dir", { "com.docker.compose.project.working_dir": undefined }, /unsafe com\.docker\.compose\.project\.working_dir/],
      ["relative working_dir", { "com.docker.compose.project.working_dir": "relative/dir" }, /unsafe com\.docker\.compose\.project\.working_dir/],
      ["working_dir with ':'", { "com.docker.compose.project.working_dir": "/opt/a:b" }, /unsafe com\.docker\.compose\.project\.working_dir/],
      ["working_dir with ','", { "com.docker.compose.project.working_dir": "/opt/a,readonly=false" }, /unsafe com\.docker\.compose\.project\.working_dir/],
      ["missing config_files", { "com.docker.compose.project.config_files": undefined }, /Missing com\.docker\.compose\.project\.config_files label/],
      ["empty config_files list", { "com.docker.compose.project.config_files": " , " }, /Empty com\.docker\.compose\.project\.config_files label/],
      ["option-shaped service", { "com.docker.compose.service": "--remove-orphans" }, /Invalid com\.docker\.compose\.service label/],
      ["service with a space", { "com.docker.compose.service": "relay x" }, /Invalid com\.docker\.compose\.service label/],
    ];
    for (const [name, overrides, message] of labelCases) {
      it(`refuses on ${name}`, async () => {
        const labels: Record<string, string> = defaultLabels();
        for (const [key, value] of Object.entries(overrides)) {
          if (value === undefined) delete labels[key];
          else labels[key] = value;
        }
        mockDocker({ labels });
        await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(message);
      });
    }

    it("refuses an existing config file outside working_dir (traversal or sibling prefix) before reading it", async () => {
      const { mkdir } = await import("node:fs/promises");
      const outside = join(tempDir, "outside.yml");
      await writeFile(outside, `services:\n  relay:\n    image: ${RELAY_IMAGE}\n`, "utf-8");
      await mkdir(`${composeDir}-sibling`, { recursive: true });
      const sibling = `${composeDir}-sibling/docker-compose.yml`;
      await writeFile(sibling, `services:\n  relay:\n    image: ${RELAY_IMAGE}\n`, "utf-8");

      for (const entry of ["../outside.yml", sibling]) {
        mockDocker({
          labels: { ...defaultLabels(), "com.docker.compose.project.config_files": entry },
        });
        await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
          /resolves outside working directory/,
        );
        expect(mockRunExec.mock.calls.some(([, args]) => args.includes("cat"))).toBe(false);
      }
    });

    it("refuses when the compose service is build-based or omits 'image:'", async () => {
      await writeFile(
        composeFile,
        ["services:", "  relay:", "    build: .", `    image: ${RELAY_IMAGE}`].join("\n"),
        "utf-8",
      );
      mockDocker();
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
        /build-based compose configuration/i,
      );

      await writeFile(composeFile, ["services:", "  relay:", "    restart: always"].join("\n"), "utf-8");
      mockDocker();
      await expect(discoverSelfComposeConfig(["c1"])).rejects.toThrow(
        /does not declare an 'image:'/i,
      );
    });
  });

  describe("normalizeImageRef", () => {
    it("adds the implicit :latest tag only when no tag or digest is present", () => {
      expect(normalizeImageRef("ghcr.io/lannguyensi/agent-relay")).toBe(RELAY_IMAGE);
      expect(normalizeImageRef(RELAY_IMAGE)).toBe(RELAY_IMAGE);
      expect(normalizeImageRef("localhost:5000/agent-relay")).toBe("localhost:5000/agent-relay:latest");
      expect(normalizeImageRef("ghcr.io/lannguyensi/agent-relay@sha256:abc")).toBe(
        "ghcr.io/lannguyensi/agent-relay@sha256:abc",
      );
    });
  });

  describe("prepareSelfUpdate, helper container launch, and state reconciliation", () => {
    it("pulls the target image, inspects digest & revision, writes .relay-self-update.json, spawns a labelled detached helper container via runExec argv array, and reconciles on restart", async () => {
      mockDocker();

      const accepted = await prepareSelfUpdate({
        tag: "latest",
        candidates: ["agent-relay"],
        postSpawnLockMs: 0,
      });

      expect(accepted).toMatchObject({
        status: "accepted",
        tag: "latest",
        targetImage: RELAY_IMAGE,
        digest: DIGEST,
        previousRevision: OLD_SHA,
        targetRevision: NEW_SHA,
      });

      const inProgressState = await readSelfUpdateState();
      expect(inProgressState).toMatchObject({
        status: "in_progress",
        tag: "latest",
        targetImage: RELAY_IMAGE,
        digest: DIGEST,
        previousRevision: OLD_SHA,
        targetRevision: NEW_SHA,
      });

      await accepted.launchHelper();

      expect(mockRunShell).not.toHaveBeenCalled();
      const runCall = mockRunExec.mock.calls.find(
        ([cmd, args]) => cmd === "docker" && args[0] === "run" && !args.includes("cat"),
      );
      expect(runCall?.[1]).toEqual([
        "run",
        "-d",
        "--label",
        "agent-relay.self-update-helper=true",
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
        RELAY_IMAGE,
        "compose",
        "-p",
        "agent-relay",
        "-f",
        composeFile,
        "up",
        "-d",
        "relay",
      ]);
      expect(apps.isOperationLocked()).toBe(false);

      // Simulate restart onto the new revision and reconcile state
      process.env.RELAY_REVISION = NEW_SHA;
      const reconciled = await reconcileSelfUpdateState();
      expect(reconciled?.status).toBe("succeeded");
      expect(reconciled?.completedAt).toBeDefined();
    });

    it("removes helper containers of earlier self-updates before pulling", async () => {
      mockDocker({ oldHelperIds: "0123456789ab\nnot-an-id\nabcdef012345\n" });
      await prepareSelfUpdate({ candidates: ["agent-relay"], postSpawnLockMs: 0 });
      const rmCall = mockRunExec.mock.calls.find(([, args]) => args[0] === "rm");
      expect(rmCall?.[1]).toEqual(["rm", "-f", "0123456789ab", "abcdef012345"]);
    });

    it("refuses with SelfUpdateRefusedError, before pulling, when the compose file pins a different image than the target", async () => {
      mockDocker();
      await expect(
        prepareSelfUpdate({ tag: "main-abc1234", candidates: ["agent-relay"], postSpawnLockMs: 0 }),
      ).rejects.toThrow(/pins image 'ghcr\.io\/lannguyensi\/agent-relay:latest'/);
      expect(mockRunExec.mock.calls.some(([, args]) => args[0] === "pull")).toBe(false);
      expect((await readSelfUpdateState())?.status).toBe("refused");
      expect(apps.isOperationLocked()).toBe(false);

      await writeFile(
        composeFile,
        `services:\n  relay:\n    image: ghcr.io/lannguyensi/agent-relay:main-abc1234\n`,
        "utf-8",
      );
      mockDocker();
      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"], postSpawnLockMs: 0 }),
      ).rejects.toThrow(SelfUpdateRefusedError);

      mockDocker();
      const accepted = await prepareSelfUpdate({
        tag: "main-abc1234",
        candidates: ["agent-relay"],
        postSpawnLockMs: 0,
      });
      expect(accepted.targetImage).toBe("ghcr.io/lannguyensi/agent-relay:main-abc1234");
    });

    it("records failed state and releases the lock if docker pull fails", async () => {
      mockDocker({ pullError: "manifest unknown" });

      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"], postSpawnLockMs: 0 }),
      ).rejects.toThrow(SelfUpdateExecutionError);

      const state = await readSelfUpdateState();
      expect(state?.status).toBe("failed");
      expect(state?.error).toContain("manifest unknown");
      expect(apps.isOperationLocked()).toBe(false);
    });

    it("records failed state and releases the lock if the helper container cannot be started", async () => {
      mockDocker({ helperRunError: "image has no docker binary" });
      const accepted = await prepareSelfUpdate({ candidates: ["agent-relay"], postSpawnLockMs: 5000 });
      expect(apps.isOperationLocked()).toBe(true);

      await accepted.launchHelper();
      expect(apps.isOperationLocked()).toBe(false);
      const state = await readSelfUpdateState();
      expect(state).toMatchObject({ status: "failed", error: "image has no docker binary" });
    });

    it("keeps the lock for postSpawnLockMs after spawning the helper, then releases it", async () => {
      vi.useFakeTimers();
      try {
        mockDocker();
        const accepted = await prepareSelfUpdate({ candidates: ["agent-relay"], postSpawnLockMs: 1000 });
        await accepted.launchHelper();
        expect(apps.isOperationLocked()).toBe(true);
        vi.advanceTimersByTime(999);
        expect(apps.isOperationLocked()).toBe(true);
        vi.advanceTimersByTime(1);
        expect(apps.isOperationLocked()).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("reconcileSelfUpdateState", () => {
    async function seedInProgress(overrides: Partial<import("./self-update.js").SelfUpdateStateRecord> = {}) {
      const now = new Date().toISOString();
      await writeSelfUpdateState({
        status: "in_progress",
        tag: "latest",
        targetImage: RELAY_IMAGE,
        digest: DIGEST,
        previousRevision: OLD_SHA,
        targetRevision: NEW_SHA,
        requestedAt: now,
        updatedAt: now,
        helperContainerName: "agent-relay-self-update-1",
        recovery: "recover via SSH",
        ...overrides,
      });
    }

    it("keeps the record in_progress while the helper is still running", async () => {
      await seedInProgress();
      mockDocker({ helperState: { Status: "running", ExitCode: 0 } });
      expect((await reconcileSelfUpdateState())?.status).toBe("in_progress");
    });

    it("marks the record failed with exit code and log tail when the helper exited non-zero", async () => {
      await seedInProgress();
      mockDocker({ helperState: { Status: "exited", ExitCode: 1 }, helperLogs: "no such service: relay" });
      const record = await reconcileSelfUpdateState();
      expect(record).toMatchObject({ status: "failed" });
      expect(record?.error).toMatch(/exited with code 1: no such service: relay/);
      expect((await readSelfUpdateState())?.status).toBe("failed");
    });

    it("marks the record failed when the helper exited 0 but the relay still runs the old revision", async () => {
      await seedInProgress();
      mockDocker({ helperState: { Status: "exited", ExitCode: 0 } });
      const record = await reconcileSelfUpdateState();
      expect(record?.status).toBe("failed");
      expect(record?.error).toMatch(/still runs revision 1{40} instead of 2{40}/);
    });

    it("marks the record unverified when the helper exited 0 and the target revision is unknown", async () => {
      await seedInProgress({ targetRevision: "unknown" });
      mockDocker({ helperState: { Status: "exited", ExitCode: 0 } });
      expect((await reconcileSelfUpdateState())?.status).toBe("unverified");
    });

    it("marks a record without helper outcome failed only after the stale deadline", async () => {
      await seedInProgress({ requestedAt: new Date(Date.now() - 5 * 60_000).toISOString() });
      mockDocker({ helperState: null });
      expect((await reconcileSelfUpdateState())?.status).toBe("in_progress");

      await seedInProgress({ requestedAt: new Date(Date.now() - 11 * 60_000).toISOString() });
      const record = await reconcileSelfUpdateState();
      expect(record?.status).toBe("failed");
      expect(record?.error).toMatch(/did not complete in time/);
    });

    it("reconciles a pending record when the app starts", async () => {
      await seedInProgress();
      process.env.RELAY_REVISION = NEW_SHA;
      const { createApp } = await import("../server.js");
      createApp();
      await vi.waitFor(async () => {
        expect((await readSelfUpdateState())?.status).toBe("succeeded");
      });
    });

    it("leaves finished records untouched", async () => {
      await seedInProgress({ status: "refused" });
      mockDocker({ helperState: { Status: "exited", ExitCode: 1 } });
      expect((await reconcileSelfUpdateState())?.status).toBe("refused");
      expect(mockRunExec).not.toHaveBeenCalled();
    });
  });

  describe("shared concurrency lock (both directions)", () => {
    const demoConfig = {
      name: "demo",
      health: "/health",
      compose_file: "docker-compose.yml",
      pre_update: [],
      post_update: [],
      rollback: false,
      command: "echo ok",
    };

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

      const inFlightDeploy = deploy({ appDir: composeDir, config: demoConfig });

      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"] }),
      ).rejects.toThrow(DeployConflictError);

      releaseDeployGate();
      await inFlightDeploy;
    });

    it("lets deploys of different apps run side by side", async () => {
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      let gitCalls = 0;
      mockRunExec.mockImplementation(async (cmd, args) => {
        if (cmd === "git" && args.includes("rev-parse")) {
          gitCalls++;
          await gate;
          return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      const first = deploy({ appDir: join(tempDir, "app-a"), config: { ...demoConfig, name: "a" } });
      const second = deploy({ appDir: join(tempDir, "app-b"), config: { ...demoConfig, name: "b" } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(gitCalls).toBe(2);
      expect(apps.isOperationLocked()).toBe(true);

      releaseGate();
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(apps.isOperationLocked()).toBe(false);
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
      mockDocker();

      const accepted = await prepareSelfUpdate({
        tag: "latest",
        candidates: ["agent-relay"],
        postSpawnLockMs: 5000,
      });

      await expect(apps.deployApp("demo")).rejects.toThrow(DeployConflictError);
      await expect(apps.deployAppStreaming("demo")).rejects.toThrow(DeployConflictError);
      await expect(apps.rollbackApp("demo")).rejects.toThrow(DeployConflictError);
      await expect(
        deploy({ appDir: composeDir, config: demoConfig }),
      ).rejects.toThrow(DeployConflictError);
      await expect(
        prepareSelfUpdate({ tag: "latest", candidates: ["agent-relay"] }),
      ).rejects.toThrow(DeployConflictError);

      await accepted.launchHelper();
      resetOperationLockForTests();
    });
  });
});
