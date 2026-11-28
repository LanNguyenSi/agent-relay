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
vi.mock("./services/env.js", async () => {
  const actual = await vi.importActual<typeof import("./services/env.js")>("./services/env.js");
  return { ...actual, readAppEnv: vi.fn().mockResolvedValue([]), writeAppEnv: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("./services/history.js", () => ({ recordDeploy: vi.fn(), getHistory: vi.fn() }));
vi.mock("./deploy/self-update.js", async () => {
  const actual = await vi.importActual<typeof import("./deploy/self-update.js")>("./deploy/self-update.js");
  return { ...actual, reconcileSelfUpdateState: vi.fn().mockResolvedValue(null) };
});

import { createApp } from "./server.js";
import {
  API_MAX_BODY_BYTES,
  ENV_MAX_ENTRIES,
  ENV_MAX_KEY,
  ENV_MAX_VALUE,
  ENV_PUT_MAX_BODY_BYTES,
} from "./api/body-limit.js";
import * as appEnv from "./services/env.js";
import * as apps from "./services/apps.js";
import * as historyMod from "./services/history.js";
import { env } from "./config/env.js";

const mockDeployApp = vi.mocked(apps.deployApp);
const mockWriteAppEnv = vi.mocked(appEnv.writeAppEnv);
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

function send(
  method: string,
  path: string,
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
    new Request(`http://test${path}`, {
      method,
      headers,
      body,
      ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
    }),
  );
}

function post(
  body: string | ReadableStream<Uint8Array>,
  opts: { authorized?: boolean; contentLength?: boolean } = {},
) {
  return send("POST", "/api/apps/demo/deploy", body, opts);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeployApp.mockResolvedValue({ success: true, commitBefore: "a", commitAfter: "b", durationMs: 0, steps: [] } as never);
  mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);
});

describe("bodyLimit on /api", () => {
  it("caps small routes at 1 MiB", () => {
    expect(API_MAX_BODY_BYTES).toBe(1024 * 1024);
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

// The largest body the env PUT's per-field limits admit: every key and value
// character spelled as a 6-byte `\uXXXX` escape. Keys differ in their last
// two units so the entries stay distinct.
function hex2(n: number): string {
  return n.toString(16).padStart(2, "0");
}
function maximalEnvBody(): string {
  const value = "\\u0001".repeat(ENV_MAX_VALUE);
  const rows: string[] = [];
  for (let i = 0; i < ENV_MAX_ENTRIES; i++) {
    const key = "\\u0001".repeat(ENV_MAX_KEY - 2) + `\\u00${hex2(i & 255)}` + `\\u00${hex2(i >> 8)}`;
    rows.push(`{"key":"${key}","value":"${value}"}`);
  }
  return `{"entries":[${rows.join(",")}]}`;
}
const ENV_PATH = "/api/apps/demo/env";

describe("bodyLimit selection per route", () => {
  it("computes the env PUT cap from the per-field limits (6 bytes per character)", () => {
    expect(ENV_PUT_MAX_BODY_BYTES).toBe(
      ENV_MAX_ENTRIES * (22 + 6 * (ENV_MAX_KEY + ENV_MAX_VALUE)) + 13,
    );
    expect(ENV_PUT_MAX_BODY_BYTES).toBe(98_699_013);
  });

  it("the maximal escaped env body is exactly the cap and is accepted", async () => {
    const body = maximalEnvBody();
    expect(body.length).toBe(ENV_PUT_MAX_BODY_BYTES);

    const res = await send("PUT", ENV_PATH, body);

    expect(res.status).toBe(200);
    expect(mockWriteAppEnv).toHaveBeenCalledTimes(1);
  });

  it("refuses an env PUT one byte over its cap with 413 and never calls the handler", async () => {
    const res = await send("PUT", ENV_PATH, maximalEnvBody() + " ");

    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: "Request body too large" });
    expect(mockWriteAppEnv).not.toHaveBeenCalled();
  });

  it("gives the env PUT with a trailing slash the same cap", async () => {
    const res = await send("PUT", `${ENV_PATH}/`, maximalEnvBody());

    expect(res.status).not.toBe(413);
  });

  it("answers GET of the env path normally (a GET has no body for the cap to apply to)", async () => {
    const res = await createApp().fetch(
      new Request(`http://test${ENV_PATH}`, { method: "GET", headers: { Authorization: AUTH } }),
    );

    expect(res.status).toBe(200);
  });

  it("refuses a 1 MiB + 1 body on DELETE of the env path with 413", async () => {
    const res = await send("DELETE", ENV_PATH, "a".repeat(API_MAX_BODY_BYTES + 1));

    expect(res.status).toBe(413);
  });

  it("refuses a 1 MiB + 1 body on POST to the env path with 413", async () => {
    const res = await send("POST", ENV_PATH, "a".repeat(API_MAX_BODY_BYTES + 1));

    expect(res.status).toBe(413);
  });

  it("refuses a 1 MiB + 1 body on PUT to a deeper path under env with 413", async () => {
    const res = await send("PUT", `${ENV_PATH}/extra`, "a".repeat(API_MAX_BODY_BYTES + 1));

    expect(res.status).toBe(413);
  });

  it("answers 401 to an unauthenticated oversized env PUT", async () => {
    const res = await send("PUT", ENV_PATH, "a".repeat(API_MAX_BODY_BYTES + 1), {
      authorized: false,
      contentLength: true,
    });

    expect(res.status).toBe(401);
    expect(mockWriteAppEnv).not.toHaveBeenCalled();
  });
});
