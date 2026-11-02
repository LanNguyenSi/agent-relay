/**
 * The post-deploy build-cache prune step as seen on the HTTP deploy routes.
 *
 * The `stream=true` route holds the shared operation lock itself from before
 * its config resolution (so a self-update landing there is the one refused),
 * and deploy() adds a second entry of its own. The prune gates on "some
 * operation other than mine holds the lock" by ENTRY IDENTITY, so it has to
 * recognise the route's entry as this deploy's own; if it did not, every
 * stream deploy would record `build cache prune` as `skipped` while the
 * non-stream route pruned fine. deploy-panel only ever uses `stream=true`,
 * so this is the production path.
 *
 * Real routes, real services and real engine (the prune decision lives in
 * engine.ts), with exec/preflight/config/history mocked, so a step status is
 * the engine's own verdict and not a fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

vi.mock("../deploy/exec.js", () => ({ runShell: vi.fn(), runExec: vi.fn() }));
vi.mock("../deploy/preflight.js", async () => {
  const actual = await vi.importActual<typeof import("../deploy/preflight.js")>("../deploy/preflight.js");
  return { ...actual, runPreflightChecks: vi.fn() };
});
vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return { ...actual, loadRelayConfig: vi.fn() };
});
vi.mock("../services/history.js", () => ({ recordDeploy: vi.fn(), getHistory: vi.fn() }));

import { api } from "./routes.js";
import { env } from "../config/env.js";
import { runExec, runShell } from "../deploy/exec.js";
import { runPreflightChecks } from "../deploy/preflight.js";
import { loadRelayConfig } from "../config/relay.js";
import { recordDeploy } from "../services/history.js";
import {
  BUILD_CACHE_PRUNE_STEP_NAME,
  acquireOperationLock,
  resetOperationLockForTests,
} from "../deploy/engine.js";

const mockRunExec = vi.mocked(runExec);
const mockRunShell = vi.mocked(runShell);
const mockLoadRelayConfig = vi.mocked(loadRelayConfig);
const mockRunPreflightChecks = vi.mocked(runPreflightChecks);
const mockRecordDeploy = vi.mocked(recordDeploy);

const cfg = {
  name: "demo",
  health: "/health",
  compose_file: "docker-compose.yml",
  pre_update: [],
  post_update: [],
  rollback: true,
} as never;

interface Step {
  name: string;
  status: string;
  output?: string;
}

let appsDir: string;
const heldLocks: Array<() => void> = [];

/** Every `docker builder prune` call the engine made during the test. */
function pruneCalls() {
  return mockRunExec.mock.calls.filter(
    ([command, args]) => command === "docker" && args.includes("builder") && args.includes("prune"),
  );
}

function post(path: string) {
  return api.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.AUTH_TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    }),
  );
}

/** The `step` events of an SSE deploy stream, in arrival order, plus the raw
 * body (readable once, so every assertion works off this single read). */
async function readStream(res: Response): Promise<{ text: string; steps: Step[] }> {
  const text = await res.text();
  const steps = text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("event: step\n"))
    .map((chunk) => JSON.parse(chunk.slice("event: step\ndata: ".length)) as Step);
  return { text, steps };
}

describe("POST /apps/:name/deploy - build cache prune step", () => {
  beforeEach(async () => {
    resetOperationLockForTests();
    appsDir = await mkdtemp(resolve(tmpdir(), "agent-relay-prune-"));
    await mkdir(join(appsDir, "demo"), { recursive: true });
    (env as { APPS_DIR: string }).APPS_DIR = appsDir;
    process.env.RELAY_BUILD_CACHE_KEEP = "168h";

    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse")) return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      if (command === "docker" && args.includes("builder")) {
        return { stdout: "Total reclaimed space: 1.5GB\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("exec")) return { stdout: "HTTP_STATUS=200\n", stderr: "", exitCode: 0 };
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    mockRunShell.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    mockLoadRelayConfig.mockResolvedValue(cfg);
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] } as never);
    mockRecordDeploy.mockResolvedValue({ id: "d1" } as never);
  });

  afterEach(async () => {
    for (const release of heldLocks.splice(0)) release();
    resetOperationLockForTests();
    delete process.env.RELAY_BUILD_CACHE_KEEP;
    await rm(appsDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("ends a successful stream=true deploy with a succeeded prune (the route's own lock entry is not a competitor)", async () => {
    const res = await post("/apps/demo/deploy?stream=true");

    expect(res.status).toBe(200);
    const { text, steps } = await readStream(res);
    expect(text).toContain("event: done");
    const prune = steps.find((step) => step.name === BUILD_CACHE_PRUNE_STEP_NAME);
    expect(prune?.status).toBe("success");
    expect(prune?.output).toContain("Total reclaimed space: 1.5GB");
    expect(pruneCalls()).toHaveLength(1);
    // The engine ran the real deploy, so the stream ended as a normal deploy.
    expect(mockRecordDeploy).toHaveBeenCalled();
  });

  it("skips the prune of a stream=true deploy while another deploy holds the lock, and still reports success", async () => {
    heldLocks.push(acquireOperationLock("deploy", "other-app"));

    const res = await post("/apps/demo/deploy?stream=true");

    const { text, steps } = await readStream(res);
    expect(text).toContain("event: done");
    const prune = steps.find((step) => step.name === BUILD_CACHE_PRUNE_STEP_NAME);
    expect(prune?.status).toBe("skipped");
    expect(prune?.output).toBe("skipped: another operation active");
    expect(pruneCalls()).toHaveLength(0);
  });

  it("skips the prune of a stream=true deploy while a rollback holds the lock", async () => {
    heldLocks.push(acquireOperationLock("rollback", "demo"));

    const res = await post("/apps/demo/deploy?stream=true");

    const { text, steps } = await readStream(res);
    expect(text).toContain("event: done");
    const prune = steps.find((step) => step.name === BUILD_CACHE_PRUNE_STEP_NAME);
    expect(prune?.status).toBe("skipped");
    expect(pruneCalls()).toHaveLength(0);
  });

  it("ends a successful non-stream deploy with a succeeded prune", async () => {
    const res = await post("/apps/demo/deploy");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { success: boolean; steps: Step[] } };
    expect(body.result.success).toBe(true);
    const prune = body.result.steps.find((step) => step.name === BUILD_CACHE_PRUNE_STEP_NAME);
    expect(prune?.status).toBe("success");
    expect(pruneCalls()).toHaveLength(1);
  });
});
