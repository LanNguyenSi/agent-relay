/**
 * Unit tests for the constant-time bearer-token check shared by the HTTP API
 * and the MCP endpoint. AUTH_TOKEN is seeded by vitest.setup.ts.
 */
import { describe, it, expect } from "vitest";
import { safeEqual, isAuthorized } from "./auth.js";
import { env } from "./env.js";

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("returns false for differing same-length strings", () => {
    expect(safeEqual("hunter2", "hunterX")).toBe(false);
  });

  it("returns false (without throwing) for differing lengths", () => {
    expect(safeEqual("short", "longer-value")).toBe(false);
  });
});

describe("isAuthorized", () => {
  it("accepts the correct bearer token", () => {
    expect(isAuthorized(`Bearer ${env.AUTH_TOKEN}`)).toBe(true);
  });

  it("rejects a wrong token", () => {
    expect(isAuthorized(`Bearer ${env.AUTH_TOKEN}x`)).toBe(false);
  });

  it("rejects a missing header", () => {
    expect(isAuthorized(undefined)).toBe(false);
  });

  it("rejects a non-Bearer scheme", () => {
    expect(isAuthorized(`Basic ${env.AUTH_TOKEN}`)).toBe(false);
  });
});
