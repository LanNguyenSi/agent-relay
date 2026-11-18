/**
 * Body-size cap for the authenticated /api routes (Hono bodyLimit, registered
 * in the /api router AFTER the auth middleware). Auth runs first: an
 * unauthenticated request is answered 401 before any of its body is read, so
 * an over-limit body (even a chunked one, which bodyLimit would otherwise
 * buffer up to the cap before next()) never pins memory for an anonymous
 * connection. For an authenticated request the cap must reject an oversized
 * body with 413 JSON before any route handler parses it, accept a body
 * exactly at the limit, and work both via an explicit Content-Length header
 * and via a chunked body with no Content-Length (byte-count enforcement, so a
 * spoofable header is not the only gate). The /mcp transport is mounted
 * outside Hono in createRelayServer and is deliberately out of scope.
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

import { createApp } from "./server.js";
import { API_MAX_BODY_BYTES } from "./api/body-limit.js";
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

function overLimitStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder().encode(OVER_LIMIT);
      const chunkSize = 256 * 1024;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
}

function post(
  body: string | ReadableStream<Uint8Array>,
  opts: { authorized?: boolean; contentLength?: boolean } = {},
) {
  const authorized = opts.authorized ?? true;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authorized) headers.Authorization = AUTH;
  // new Request(url, { body }) sets no Content-Length; a test that needs the
  // header sets it explicitly with the body's exact byte length (ASCII only).
  if (opts.contentLength) {
    const length = typeof body === "string" ? body.length : new TextEncoder().encode(OVER_LIMIT).length;
    headers["Content-Length"] = String(length);
  }
  return createApp().fetch(
    new Request("http://test/api/apps/demo/deploy", {
      method: "POST",
      headers,
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
    const res = await post(overLimitStream());

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
    expect(mockDeployApp).not.toHaveBeenCalled();
  });

  it("answers 401 to an unauthenticated over-limit chunked body and never buffers it or calls the handler", async () => {
    const res = await post(overLimitStream(), { authorized: false });

    expect(res.status).toBe(401);
    expect(mockDeployApp).not.toHaveBeenCalled();
  });

  it("answers 401 (not 413) to an unauthenticated over-limit body with an explicit Content-Length", async () => {
    const res = await post(OVER_LIMIT, { authorized: false, contentLength: true });

    expect(res.status).toBe(401);
    expect(mockDeployApp).not.toHaveBeenCalled();
  });

  it("rejects an authenticated over-limit body with an explicit Content-Length with 413 and never calls the handler", async () => {
    const res = await post(OVER_LIMIT, { contentLength: true });

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
    expect(mockDeployApp).not.toHaveBeenCalled();
  });

  it("accepts an authenticated body exactly at the cap with an explicit Content-Length", async () => {
    const res = await post(AT_LIMIT, { contentLength: true });

    expect(res.status).not.toBe(413);
    expect(mockDeployApp).toHaveBeenCalledTimes(1);
  });
});
