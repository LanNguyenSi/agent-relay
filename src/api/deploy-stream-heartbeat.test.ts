/**
 * The `stream=true` deploy route sends an SSE comment line (`: ping`) at a
 * fixed interval while the deploy runs, so a reverse proxy with an idle/read
 * timeout does not drop a stream that is silent between steps. The interval
 * is shortened through the route's test hook; the tests wait on stream
 * content or on a settled promise, never on fixed sleeps.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api, setSseHeartbeatIntervalForTests } from "./routes.js";
import { env } from "../config/env.js";
import * as relayMod from "../config/relay.js";
import * as apps from "../services/apps.js";
import * as historyMod from "../services/history.js";
import { isOperationLocked, resetOperationLockForTests } from "../deploy/engine.js";

vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return { ...actual, loadRelayConfig: vi.fn() };
});

vi.mock("../services/history.js", () => ({
  recordDeploy: vi.fn(),
  getHistory: vi.fn(),
}));

const mockLoadRelayConfig = vi.mocked(relayMod.loadRelayConfig);
const mockRecordDeploy = vi.mocked(historyMod.recordDeploy);

const OK_RESULT = { success: true, commitBefore: "aaa", commitAfter: "bbb", durationMs: 1, steps: [] };
const INTERVAL_MS = 5;

function streamDeploy() {
  return api.fetch(
    new Request("http://test/apps/demo/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.AUTH_TOKEN}` },
      body: JSON.stringify({}),
    }),
  );
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Read chunks until `predicate(accumulated text)` holds; returns the text. */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (!predicate(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("stream deploy heartbeat", () => {
  beforeEach(() => {
    resetOperationLockForTests();
    setSseHeartbeatIntervalForTests(INTERVAL_MS);
    mockLoadRelayConfig.mockResolvedValue({ compose_file: "docker-compose.yml" } as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);
  });

  afterEach(() => {
    setSseHeartbeatIntervalForTests();
    resetOperationLockForTests();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("sends several ping comments while a step is silent, before the done event", async () => {
    const deployGate = gate();
    vi.spyOn(apps, "deployAppStreaming").mockImplementation(async () => {
      await deployGate.promise;
      return OK_RESULT as never;
    });

    const res = await streamDeploy();
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();

    const early = await readUntil(reader, (t) => (t.match(/: ping\n\n/g) ?? []).length >= 3);
    expect(early).not.toContain("event:");

    deployGate.open();
    const rest = await readUntil(reader, (t) => t.includes("event: done"));
    expect(rest).toContain("event: done");
    expect(early.startsWith(": ping\n\n")).toBe(true);
  });

  it("stops the heartbeat once the deploy is done", async () => {
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    vi.spyOn(apps, "deployAppStreaming").mockResolvedValue(OK_RESULT as never);

    const res = await streamDeploy();
    const text = await res.text();
    expect(text).toContain("event: done");

    const heartbeat = setSpy.mock.results.find((r) => r.value !== undefined)?.value;
    expect(heartbeat).toBeDefined();
    expect(clearSpy).toHaveBeenCalledWith(heartbeat);
    expect(isOperationLocked()).toBe(false);
  });

  it("clears the interval on client cancel while the deploy keeps running", async () => {
    const deployGate = gate();
    const setSpy = vi.spyOn(globalThis, "setInterval");
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    vi.spyOn(apps, "deployAppStreaming").mockImplementation(async () => {
      await deployGate.promise;
      return OK_RESULT as never;
    });

    const res = await streamDeploy();
    const reader = res.body!.getReader();
    await readUntil(reader, (t) => t.includes(": ping"));
    const heartbeat = setSpy.mock.results[setSpy.mock.results.length - 1]!.value;

    await reader.cancel();
    // Cleared by cancel() itself, while the deploy has not settled yet.
    expect(clearSpy).toHaveBeenCalledWith(heartbeat);
    expect(isOperationLocked()).toBe(true);

    deployGate.open();
    await vi.waitFor(() => expect(mockRecordDeploy).toHaveBeenCalled());
    await vi.waitFor(() => expect(isOperationLocked()).toBe(false));
  });

  it("never enqueues into a cancelled stream even when the interval would still fire", async () => {
    const deployGate = gate();
    const handles: Array<ReturnType<typeof setInterval>> = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    let ticksAfterCancel = 0;
    let cancelledNow = false;
    // Keep the timer alive after cancel and count its ticks: only the
    // cancelled guard can then stop the callback from enqueuing into the
    // dead controller.
    vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms: number) => {
      const h = realSet(() => {
        if (cancelledNow) ticksAfterCancel++;
        fn();
      }, ms);
      handles.push(h);
      return h;
    }) as never);
    vi.spyOn(globalThis, "clearInterval").mockImplementation((() => {}) as never);
    const errors: unknown[] = [];
    const onUncaught = (err: unknown) => errors.push(err);
    process.on("uncaughtException", onUncaught);

    try {
      vi.spyOn(apps, "deployAppStreaming").mockImplementation(async () => {
        await deployGate.promise;
        return OK_RESULT as never;
      });
      const res = await streamDeploy();
      const reader = res.body!.getReader();
      await readUntil(reader, (t) => t.includes(": ping"));
      await reader.cancel();
      cancelledNow = true;

      // Wait until the still-armed timer has fired at least twice after cancel.
      await vi.waitFor(() => expect(ticksAfterCancel).toBeGreaterThanOrEqual(2));
      // One more macrotask so a throw from the last tick would surface.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(errors).toEqual([]);

      deployGate.open();
      await vi.waitFor(() => expect(isOperationLocked()).toBe(false));
    } finally {
      process.off("uncaughtException", onUncaught);
      for (const h of handles) realClear(h);
    }
  });

  it("marks the stream unbuffered for nginx", async () => {
    vi.spyOn(apps, "deployAppStreaming").mockResolvedValue(OK_RESULT as never);
    const res = await streamDeploy();
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    await res.text();
  });
});
