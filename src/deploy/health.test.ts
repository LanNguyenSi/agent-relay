/**
 * Tests for checkHealth in src/deploy/health.ts.
 * Covers: exponential backoff math, max-delay cap, retries+1 loop bound,
 * and network-error swallow.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkHealth } from "./health.js";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── success paths ─────────────────────────────────────────────────────────────

describe("checkHealth — success", () => {
  it("returns true immediately when fetch succeeds on the first attempt", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const result = await checkHealth({ url: "http://localhost/health", retries: 3, initialDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns true when fetch succeeds after one retry", async () => {
    // First call fails, second succeeds.
    fetchMock
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockResolvedValueOnce({ ok: true });

    const result = await checkHealth({ url: "http://localhost/health", retries: 3, initialDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns true when fetch returns a 200-range response (ok=true)", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const result = await checkHealth({ url: "http://localhost:3000/health", retries: 0, initialDelayMs: 1 });
    expect(result).toBe(true);
  });
});

// ── failure / retry-bound ────────────────────────────────────────────────────

describe("checkHealth — failure after exhausting retries", () => {
  it("returns false after exhausting all retries", async () => {
    fetchMock.mockRejectedValue(new Error("network error"));

    const result = await checkHealth({ url: "http://localhost/health", retries: 2, initialDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe(false);
  });

  it("calls fetch exactly retries+1 times (loop: 0..retries inclusive)", async () => {
    fetchMock.mockRejectedValue(new Error("timeout"));

    await checkHealth({ url: "http://localhost/health", retries: 4, initialDelayMs: 1, maxDelayMs: 5 });

    // retries=4 → attempts 0,1,2,3,4 → 5 calls total
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("returns false when retries=0 and the single attempt fails", async () => {
    fetchMock.mockRejectedValue(new Error("refused"));

    const result = await checkHealth({ url: "http://localhost/health", retries: 0, initialDelayMs: 1 });

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns false when fetch returns non-ok response (ok=false)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 });

    const result = await checkHealth({ url: "http://localhost/health", retries: 1, initialDelayMs: 1, maxDelayMs: 5 });

    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// ── network-error swallow ─────────────────────────────────────────────────────

describe("checkHealth — network error swallow", () => {
  it("swallows network errors and retries instead of throwing", async () => {
    // All attempts throw a network error — the function must return false, not re-throw.
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    await expect(
      checkHealth({ url: "http://localhost/health", retries: 2, initialDelayMs: 1, maxDelayMs: 5 }),
    ).resolves.toBe(false);
  });

  it("swallows AbortError (timeout) without propagating it", async () => {
    const abortError = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    fetchMock.mockRejectedValue(abortError);

    await expect(
      checkHealth({ url: "http://localhost/health", retries: 1, initialDelayMs: 1, maxDelayMs: 5 }),
    ).resolves.toBe(false);
  });
});

// ── exponential backoff + max-delay cap ──────────────────────────────────────

describe("checkHealth — exponential backoff and max-delay cap", () => {
  it("delays between retries instead of polling immediately (verified via fake timers)", async () => {
    // With fake timers the sleep() Promises never resolve unless we advance
    // time. If there were no delay between attempts this test would not need
    // fake timers and would complete instantly regardless.
    vi.useFakeTimers();

    fetchMock.mockRejectedValue(new Error("network error"));

    const promise = checkHealth({ url: "http://localhost/health", retries: 2, initialDelayMs: 500, maxDelayMs: 2000 });

    // After first attempt (attempt=0) there should be no sleep yet, but then
    // attempt=1 sleep fires. Advance time to drain all pending sleeps.
    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("caps delay at maxDelayMs (the cap kicks in before uncapped delay overflows)", async () => {
    vi.useFakeTimers();

    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    fetchMock.mockRejectedValue(new Error("down"));

    // initialDelayMs=1000, maxDelayMs=1500 — with 4 retries the uncapped
    // delays would be 1000, 2000, 4000, 8000. With the cap they become
    // 1000, 1500, 1500, 1500.
    const promise = checkHealth({ url: "http://x/h", retries: 4, initialDelayMs: 1000, maxDelayMs: 1500 });
    await vi.runAllTimersAsync();
    await promise;

    // Collect only the sleep() delays (retries = 4 → 4 sleeps; attempt 0 has no sleep).
    // setTimeout is also used internally by AbortSignal.timeout — filter by
    // delay value to isolate only the sleep calls (those match our range).
    const sleepDelays = setTimeoutSpy.mock.calls
      .map(([, delay]) => delay as number)
      .filter((d) => d !== undefined && d >= 100); // AbortSignal.timeout uses 5000ms

    expect(sleepDelays).toHaveLength(4);
    // First delay: min(1000*2^0, 1500) = 1000
    expect(sleepDelays[0]).toBe(1000);
    // Second delay: min(1000*2^1, 1500) = 1500 (capped from 2000)
    expect(sleepDelays[1]).toBe(1500);
    // Third and fourth: still 1500 (cap holds)
    expect(sleepDelays[2]).toBe(1500);
    expect(sleepDelays[3]).toBe(1500);
  });

  it("uses default values (retries=5, initialDelayMs=2000, maxDelayMs=15000) when options omitted", async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true });

    const promise = checkHealth({ url: "http://localhost/h" });
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    // Only 1 call needed (first attempt succeeds)
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
