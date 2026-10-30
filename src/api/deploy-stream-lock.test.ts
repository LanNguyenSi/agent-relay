/**
 * Lock discipline on the `stream=true` deploy route: the shared operation
 * lock is taken synchronously with the conflict check (no await between the
 * check and the take), so a self-update can no longer slip into the old
 * check-then-act gap between the route's check and deploy() acquiring the
 * lock, and the lock never leaks past any exit path (stream end, config
 * error, client cancel). The race is made deterministic by injecting the
 * self-update lock acquire INTO the route's mocked pre-deploy await, never
 * with timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./routes.js";
import { env } from "../config/env.js";
import { RelayConfigError } from "../config/relay.js";
import * as relayMod from "../config/relay.js";
import * as apps from "../services/apps.js";
import * as historyMod from "../services/history.js";
import {
  acquireOperationLock,
  isOperationLocked,
  resetOperationLockForTests,
} from "../deploy/engine.js";

// The route resolves the app config before opening the stream; default the
// config load to success so tests only inject failures where they need them.
vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return {
    ...actual,
    loadRelayConfig: vi.fn(),
  };
});

vi.mock("../services/history.js", () => ({
  recordDeploy: vi.fn(),
  getHistory: vi.fn(),
}));

const mockLoadRelayConfig = vi.mocked(relayMod.loadRelayConfig);
const mockRecordDeploy = vi.mocked(historyMod.recordDeploy);

const AUTH = `Bearer ${env.AUTH_TOKEN}`;
const RELAY_IMAGE = "ghcr.io/lannguyensi/agent-relay:latest";
const OK_RESULT = {
  success: true,
  commitBefore: "aaa",
  commitAfter: "bbb",
  durationMs: 1,
  steps: [],
};

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return api.fetch(new Request(`http://test${path}`, { ...init, headers }));
}

function streamDeploy(name = "demo") {
  return request(`/apps/${name}/deploy?stream=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

describe("stream deploy operation lock (check-then-act race)", () => {
  // Releases for locks the test itself took (e.g. a self-update lock that
  // slipped in on the un-fixed route), kept separate from the route's own.
  let testReleases: Array<() => void>;

  beforeEach(() => {
    resetOperationLockForTests();
    testReleases = [];
    mockLoadRelayConfig.mockResolvedValue({ compose_file: "docker-compose.yml" } as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);
  });

  afterEach(() => {
    for (const release of testReleases) release();
    resetOperationLockForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("409 JSON with no SSE stream when a self-update takes the lock inside the route's pre-deploy await window", async () => {
    const realSafeAppDir = apps.safeAppDir;
    const deployStreaming = vi.spyOn(apps, "deployAppStreaming").mockImplementation(async () => {
      // Stands in for engine.deploy(), which acquires its own shared lock.
      const release = acquireOperationLock("deploy", "/apps/demo");
      release();
      return OK_RESULT as never;
    });

    vi.spyOn(apps, "safeAppDir").mockImplementation(async (name) => {
      const dir = await realSafeAppDir(name);
      // The route is now between its conflict check and deploy(): attempt
      // the exclusive self-update acquire exactly where a concurrent
      // POST /api/self-update would land it. While the route holds the
      // shared lock this throws; on the old check-only route it succeeds.
      const releaseSelfUpdate = acquireOperationLock("self-update", RELAY_IMAGE);
      testReleases.push(releaseSelfUpdate);
      return dir;
    });

    const res = await streamDeploy();

    // Fixed behaviour: the conflict is observed before the stream opens, so
    // this is a plain JSON 409 naming the self-update...
    expect(res.status).toBe(409);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("self-update");
    // ...no SSE stream was opened (deploy never attempted, nothing recorded),
    // and the refused acquire left no lock of its own behind either.
    expect(deployStreaming).not.toHaveBeenCalled();
    expect(mockRecordDeploy).not.toHaveBeenCalled();
    expect(isOperationLocked()).toBe(false);
  });

  it("releases the lock when the stream ends normally", async () => {
    vi.spyOn(apps, "deployAppStreaming").mockResolvedValue(OK_RESULT as never);

    const res = await streamDeploy();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(mockRecordDeploy).toHaveBeenCalledWith("demo", OK_RESULT, "api");

    expect(isOperationLocked()).toBe(false);
  });

  it("releases the lock on the 404 config-error path and never opens the stream", async () => {
    mockLoadRelayConfig.mockRejectedValueOnce(new RelayConfigError("No .relay.yml found"));
    const deployStreaming = vi.spyOn(apps, "deployAppStreaming").mockResolvedValue(OK_RESULT as never);

    const res = await streamDeploy("ghost");

    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toContain("text/event-stream");
    expect(deployStreaming).not.toHaveBeenCalled();
    expect(isOperationLocked()).toBe(false);
  });

  it("a shared lock held by another deploy does not block this stream deploy (shared locks stack)", async () => {
    const heldElsewhere = acquireOperationLock("deploy", "other-app");
    const deployStreaming = vi.spyOn(apps, "deployAppStreaming").mockResolvedValue(OK_RESULT as never);

    const res = await streamDeploy();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(deployStreaming).toHaveBeenCalled();
    await res.text();

    heldElsewhere();
    expect(isOperationLocked()).toBe(false);
  });

  it("releases the lock when the client cancels mid-deploy", async () => {
    let finishDeploy!: () => void;
    const gate = new Promise<void>((resolve) => {
      finishDeploy = resolve;
    });
    vi.spyOn(apps, "deployAppStreaming").mockImplementation(async (_name, _opts, onStep) => {
      await gate;
      // A step event landing after the cancel must be dropped, not thrown
      // into the closed controller (that would abort start() before the
      // history record below is written).
      onStep?.({ name: "git pull", status: "success", output: "", durationMs: 1 } as never);
      return OK_RESULT;
    });

    const res = await streamDeploy();
    // The route still holds the lock while the (still running) deploy streams.
    expect(isOperationLocked()).toBe(true);

    await res.body!.cancel();
    // Cancel is an exit: the lock is out, even though the deploy itself has
    // not finished yet.
    expect(isOperationLocked()).toBe(false);

    finishDeploy();
    // The late step/done callbacks must not throw into the cancelled
    // controller; the history record for the deploy that did run is still
    // written.
    await vi.waitFor(() => expect(mockRecordDeploy).toHaveBeenCalledWith("demo", OK_RESULT, "api"));
    expect(isOperationLocked()).toBe(false);
  });
});
