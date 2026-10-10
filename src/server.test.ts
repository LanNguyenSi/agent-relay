/**
 * Adapter-level tests (task 0d998791): the server from createRelayServer() is
 * bound to an ephemeral loopback port, so the node:http routing, the
 * @hono/node-server request listener and its SSE streaming are covered. Every
 * other suite calls api.fetch() directly and would not notice an adapter
 * regression.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

vi.mock("./config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("./config/relay.js")>("./config/relay.js");
  return {
    ...actual,
    loadRelayConfig: vi.fn().mockResolvedValue({ compose_file: "docker-compose.yml" } as never),
  };
});

vi.mock("./services/apps.js", async () => {
  const actual = await vi.importActual<typeof import("./services/apps.js")>("./services/apps.js");
  return {
    ...actual,
    safeAppDir: vi.fn().mockResolvedValue("/nonexistent/demo"),
    deployAppStreaming: vi.fn(),
  };
});

// Imported after vi.mock so the routes receive the mocked services.
import { deployAppStreaming } from "./services/apps.js";
import { env } from "./config/env.js";
import { RELAY_VERSION } from "./config/version.js";
import { createRelayServer } from "./server.js";

const AUTH = `Bearer ${env.AUTH_TOKEN}`;

let server: Server | undefined;
const cleanups: Array<() => void> = [];

async function listen(): Promise<string> {
  server = createRelayServer();
  const s = server;
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = s.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()?.();
  const s = server;
  server = undefined;
  if (s) {
    // Drop keep-alive and still-open response sockets so close() cannot hang.
    s.closeAllConnections();
    await new Promise<void>((resolve, reject) => s.close((err) => (err ? reject(err) : resolve())));
  }
  vi.mocked(deployAppStreaming).mockReset();
});

function withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${what}: response is not streamed incrementally`)),
      3_000,
    );
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

/** Reads from the stream until one complete SSE frame (terminated by a blank line) is buffered. */
async function readFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  state: { buf: string },
): Promise<{ event: string; data: unknown } | null> {
  const decoder = new TextDecoder();
  while (state.buf.indexOf("\n\n") < 0) {
    const { value, done } = await reader.read();
    if (done) return null;
    state.buf += decoder.decode(value, { stream: true });
  }
  const end = state.buf.indexOf("\n\n");
  const frame = state.buf.slice(0, end);
  state.buf = state.buf.slice(end + 2);
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  return { event, data: JSON.parse(data) };
}

describe("relay server over a real socket: routing", () => {
  it("GET /health answers JSON through the Hono request listener", async () => {
    const url = await listen();
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ status: "ok", version: RELAY_VERSION });
  });

  it("/api rejects a request without a token with 401 JSON", async () => {
    const url = await listen();
    const res = await fetch(`${url}/api/apps`);
    expect(res.status).toBe(401);
  });

  it("/mcp is routed past Hono and rejects a missing token with the server's own 401", async () => {
    const url = await listen();
    const res = await fetch(`${url}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

describe("relay server over a real socket: SSE streaming", () => {
  it("delivers each deploy step to the client before the deploy finishes", async () => {
    // Deterministic handshake, no millisecond thresholds: the mocked deploy
    // reports one step, then withholds the next (and its result) until the
    // client confirms it read the previous frame. A buffered response can
    // never get past the first gate, so the client hits the deadline.
    let deployEnded = false;
    let ackFirst!: () => void;
    let ackSecond!: () => void;
    const firstRead = new Promise<void>((r) => (ackFirst = r));
    const secondRead = new Promise<void>((r) => (ackSecond = r));
    cleanups.push(ackFirst, ackSecond);

    vi.mocked(deployAppStreaming).mockImplementation(async (_name, _opts, onStep) => {
      onStep?.({ name: "git-pull", status: "success", output: "one", durationMs: 1 });
      await firstRead;
      onStep?.({ name: "build", status: "success", output: "two", durationMs: 1 });
      await secondRead;
      deployEnded = true;
      // A blocked result ends the stream without writing deploy history.
      return { blocked: true, preflight: { ok: false } } as never;
    });

    const url = await listen();
    const res = await withDeadline(
      fetch(`${url}/api/apps/demo/deploy?stream=true`, {
        method: "POST",
        headers: { Authorization: AUTH, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      "response headers",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const state = { buf: "" };

    const first = await withDeadline(readFrame(reader, state), "first frame");
    expect(first).toEqual({
      event: "step",
      data: { name: "git-pull", status: "success", output: "one", durationMs: 1 },
    });
    expect(deployEnded).toBe(false);
    ackFirst();

    const second = await withDeadline(readFrame(reader, state), "second frame");
    expect(second?.event).toBe("step");
    expect((second?.data as { output: string }).output).toBe("two");
    expect(deployEnded).toBe(false);
    ackSecond();

    const last = await withDeadline(readFrame(reader, state), "last frame");
    expect(last).toEqual({ event: "blocked", data: { ok: false } });
    expect(deployEnded).toBe(true);
    const end = await withDeadline(readFrame(reader, state), "stream end");
    expect(end).toBeNull();
  });
});
