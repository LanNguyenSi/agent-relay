/**
 * Body-size cap for the authenticated /api routes (Hono bodyLimit, wired in
 * createApp over /api/*). The cap must reject an oversized body with 413 JSON
 * before any route handler parses it, accept a body exactly at the limit, and
 * still work for a chunked body that carries no Content-Length (so the limit
 * is enforced by byte count, not by a spoofable header). The /mcp transport is
 * mounted outside Hono in createRelayServer and is deliberately out of scope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./services/apps.js", async () => {
  const actual = await vi.importActual<typeof import("./services/apps.js")>("./services/apps.js");
  return { ...actual, deployApp: vi.fn(), safeAppDir: vi.fn() };
});
vi.mock("./services/history.js", () => ({ recordDeploy: vi.fn(), getHistory: vi.fn() }));
vi.mock("./deploy/self-update.js", async () => {
  const actual = await vi.importActual<typeof import("./deploy/self-update.js")>("./deploy/self-update.js");
  return { ...actual, reconcileSelfUpdateState: vi.fn().mockResolvedValue(null) };
});

import { createApp, API_MAX_BODY_BYTES } from "./server.js";
import * as apps from "./services/apps.js";
import * as historyMod from "./services/history.js";
import { env } from "./config/env.js";

const mockDeployApp = vi.mocked(apps.deployApp);
const mockRecordDeploy = vi.mocked(historyMod.recordDeploy);
const AUTH = `Bearer ${env.AUTH_TOKEN}`;

// A body exactly at the cap, and one byte over. ASCII, so byte length ===
// string length; the env route is irrelevant here (we deploy), the content
// only needs to hit the byte budget.
const AT_LIMIT = "a".repeat(API_MAX_BODY_BYTES);
const OVER_LIMIT = "a".repeat(API_MAX_BODY_BYTES + 1);

function post(body: string | ReadableStream<Uint8Array>) {
  return createApp().fetch(
    new Request("http://test/api/apps/demo/deploy", {
      method: "POST",
      headers: { Authorization: AUTH, "Content-Type": "application/json" },
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeployApp.mockResolvedValue({ success: true, commitBefore: "a", commitAfter: "b", durationMs: 0, steps: [] } as never);
  mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);
});

describe("bodyLimit on /api", () => {
  it("caps at 16 MiB (the smallest power of two above the largest legitimate env PUT)", () => {
    expect(API_MAX_BODY_BYTES).toBe(16 * 1024 * 1024);
  });

  it("rejects a body one byte over the cap with 413 JSON and never calls the handler", async () => {
    const res = await post(OVER_LIMIT);

    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ error: "Request body too large" });
    expect(mockDeployApp).not.toHaveBeenCalled();
  });

  it("accepts a body exactly at the cap (handler runs, not a 413)", async () => {
    const res = await post(AT_LIMIT);

    expect(res.status).not.toBe(413);
    expect(mockDeployApp).toHaveBeenCalledTimes(1);
  });

  it("enforces the cap on a chunked body with no Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(OVER_LIMIT);
        const chunkSize = 256 * 1024;
        for (let i = 0; i < bytes.length; i += chunkSize) {
          controller.enqueue(bytes.subarray(i, i + chunkSize));
        }
        controller.close();
      },
    });

    const res = await post(stream);

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
    expect(mockDeployApp).not.toHaveBeenCalled();
  });
});
