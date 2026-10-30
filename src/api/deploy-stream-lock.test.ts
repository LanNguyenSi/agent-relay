/**
 * Lock discipline on the `stream=true` deploy route: the shared operation
 * lock is taken synchronously with the conflict check (no await between the
 * check and the take), so a self-update that arrives while the route awaits
 * its config resolution is the one refused with the conflict (409
 * `relay_busy`), and the deploy proceeds normally. The lock is released only
 * in the config-phase catch and the stream's `finally`: a client cancel
 * keeps it held until the deploy finishes. The race is made deterministic by
 * injecting the self-update attempts INTO the route's mocked pre-deploy
 * await, never with timers.
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

// Locks a mocked prepareSelfUpdate actually acquired (only possible on a
// route that does not hold the lock), released in afterEach.
const selfUpdateFixtures = vi.hoisted(() => ({
  heldReleases: [] as Array<() => void>,
}));

// Keep the real lock semantics of the self-update service (step 2 of
// prepareSelfUpdate: the exclusive acquire right after tag validation, the
// only part that can run here; the compose discovery and docker pull behind
// it cannot). A conflict throws the real DeployConflictError, which the real
// POST /api/self-update route maps to 409 { kind: "relay_busy" }.
vi.mock("../deploy/self-update.js", async () => {
  const actual = await vi.importActual<typeof import("../deploy/self-update.js")>("../deploy/self-update.js");
  const targetImage = "ghcr.io/lannguyensi/agent-relay:latest";
  return {
    ...actual,
    prepareSelfUpdate: vi.fn(async () => {
      const release = actual.acquireOperationLock("self-update", targetImage);
      // Upstream holds the lock until the helper finishes; nothing in these
      // tests lets it get there, so a successful acquire keeps holding.
      selfUpdateFixtures.heldReleases.push(release);
      return {
        status: "accepted",
        tag: "latest",
        targetImage,
        digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        previousRevision: "rev-a",
        targetRevision: "rev-b",
        recovery: "mocked recovery guidance",
        launchHelper: async () => {},
      };
    }),
    logSelfUpdateEvent: vi.fn(),
  };
});

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
    for (const release of selfUpdateFixtures.heldReleases) release();
    selfUpdateFixtures.heldReleases.length = 0;
    resetOperationLockForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("refuses the self-update that lands inside the route's pre-deploy await window and deploys anyway", async () => {
    const realSafeAppDir = apps.safeAppDir;
    const deployStreaming = vi.spyOn(apps, "deployAppStreaming").mockImplementation(async () => {
      // Stands in for engine.deploy(), which acquires its own shared lock.
      const release = acquireOperationLock("deploy", "/apps/demo");
      release();
      return OK_RESULT as never;
    });

    const acquireOutcome: { refusedWith?: unknown } = {};
    let selfUpdateRes: { status: number; body: Record<string, unknown> } | undefined;

    vi.spyOn(apps, "safeAppDir").mockImplementation(async (name) => {
      const dir = await realSafeAppDir(name);
      // The route now holds the shared lock and awaits here: attempt a
      // self-update exactly where a concurrent one would land. First the
      // real POST /api/self-update, then the raw exclusive acquire. On the
      // fixed route both are refused; on the old check-only route the POST
      // succeeds and its held lock then collides with the engine's own
      // acquire, so the stream ends with an `error` event instead of `done`.
      const res = await request("/self-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      selfUpdateRes = { status: res.status, body: (await res.json()) as Record<string, unknown> };
      try {
        testReleases.push(acquireOperationLock("self-update", RELAY_IMAGE));
      } catch (err) {
        acquireOutcome.refusedWith = err;
      }
      return dir;
    });

    const res = await streamDeploy();

    // Production outcome: the self-update is refused, the deploy proceeds.
    expect(acquireOutcome.refusedWith).toBeInstanceOf(apps.DeployConflictError);
    const conflict = acquireOutcome.refusedWith as apps.DeployConflictError;
    expect(conflict.activeOperation.kind).toBe("deploy");
    // The route locks with the app NAME (deploy() itself locks with the app
    // directory), so that is what the refused self-update reports.
    expect(conflict.activeOperation.target).toBe("demo");
    expect(selfUpdateRes?.status).toBe(409);
    expect(selfUpdateRes?.body.kind).toBe("relay_busy");
    // The stream opened normally, the deploy ran, was recorded, and the
    // lock is out once the stream ended.
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("event: done");
    expect(text).not.toContain("event: error");
    expect(deployStreaming).toHaveBeenCalled();
    expect(mockRecordDeploy).toHaveBeenCalledWith("demo", OK_RESULT, "api");
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

  it("releases the lock when deployAppStreaming throws inside the stream (SSE error event)", async () => {
    vi.spyOn(apps, "deployAppStreaming").mockRejectedValue(new Error("compose build failed"));

    const res = await streamDeploy();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: error");
    expect(mockRecordDeploy).not.toHaveBeenCalled();

    // The SSE `error` path ran through the stream's finally: no leak.
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

  it("keeps the lock held after a client cancel until the deploy finishes", async () => {
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
    // The route holds the lock while the deploy runs.
    expect(isOperationLocked()).toBe(true);

    await res.body!.cancel();
    // A hung-up client is NOT an exit: the deploy is still running, so the
    // lock stays held and a self-update is still refused.
    expect(isOperationLocked()).toBe(true);

    finishDeploy();
    // The late step/done callbacks must not throw into the cancelled
    // controller; the history record for the deploy that did run is still
    // written, and the stream's finally then releases the lock.
    await vi.waitFor(() => expect(mockRecordDeploy).toHaveBeenCalledWith("demo", OK_RESULT, "api"));
    await vi.waitFor(() => expect(isOperationLocked()).toBe(false));
  });
});
