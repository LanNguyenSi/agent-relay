/**
 * Tests for deploy history persistence in src/services/history.ts.
 * Covers: corrupt/missing JSON fallback, id-counter recovery,
 * MAX_RECORDS=100 truncation, and the app filter in getHistory.
 *
 * Each test uses a fresh temp directory AND resets the module to clear the
 * in-memory `records` cache (which is module-level state).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// We control APPS_DIR via process.env because the `env` module reads from it
// at load time. `vi.resetModules()` forces a fresh load so the new APPS_DIR
// is picked up by each test.
const originalAppsDir = process.env.APPS_DIR;
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), "agent-relay-hist-"));
  process.env.APPS_DIR = tmpDir;
  vi.resetModules();
});

afterEach(async () => {
  process.env.APPS_DIR = originalAppsDir;
  await rm(tmpDir, { recursive: true, force: true });
});

async function freshHistory() {
  // Each call gets the module with reset records/counter because vi.resetModules()
  // was already called in beforeEach.
  return import("./history.js");
}

// ── missing / corrupt JSON ───────────────────────────────────────────────────

describe("recordDeploy — missing history file", () => {
  it("starts with an empty list when no history file exists", async () => {
    const { recordDeploy, getHistory } = await freshHistory();
    await recordDeploy("myapp", { success: true, commitBefore: "a", commitAfter: "b", durationMs: 10 }, "test");
    const list = await getHistory();
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("d-1");
  });
});

describe("recordDeploy — corrupt JSON file", () => {
  it("falls back to empty list and continues when JSON is corrupt", async () => {
    // Write corrupt JSON before the module loads so it tries to read it.
    await writeFile(join(tmpDir, ".relay-history.json"), "not json!!!");

    const { recordDeploy, getHistory } = await freshHistory();
    const record = await recordDeploy("myapp", { success: false, commitBefore: "a", commitAfter: "a", durationMs: 0 }, "test");

    expect(record.id).toBe("d-1");
    const list = await getHistory();
    expect(list).toHaveLength(1);
  });
});

// ── id-counter recovery ──────────────────────────────────────────────────────

describe("id-counter recovery", () => {
  it("resumes counter from highest existing id when loading from file", async () => {
    // Pre-seed the history file with records whose highest id is d-42.
    const existing = [
      { id: "d-42", app: "a", status: "success", commitBefore: "x", commitAfter: "y", durationMs: 1, triggeredBy: "ci", createdAt: new Date().toISOString() },
      { id: "d-7",  app: "a", status: "failed",  commitBefore: "y", commitAfter: "y", durationMs: 2, triggeredBy: "ci", createdAt: new Date().toISOString() },
    ];
    await writeFile(join(tmpDir, ".relay-history.json"), JSON.stringify(existing));

    const { recordDeploy } = await freshHistory();
    const record = await recordDeploy("myapp", { success: true, commitBefore: "b", commitAfter: "c", durationMs: 5 }, "test");

    // Counter should resume after 42, so next id is d-43.
    expect(record.id).toBe("d-43");
  });

  it("handles records with malformed ids gracefully (non-numeric part)", async () => {
    const existing = [
      { id: "invalid", app: "a", status: "success", commitBefore: "x", commitAfter: "y", durationMs: 1, triggeredBy: "ci", createdAt: new Date().toISOString() },
    ];
    await writeFile(join(tmpDir, ".relay-history.json"), JSON.stringify(existing));

    const { recordDeploy } = await freshHistory();
    // counter should be 0 (no valid numeric id found), so next id is d-1
    const record = await recordDeploy("myapp", { success: true, commitBefore: "b", commitAfter: "c", durationMs: 5 }, "test");
    expect(record.id).toBe("d-1");
  });
});

// ── MAX_RECORDS=100 truncation ───────────────────────────────────────────────

describe("MAX_RECORDS=100 cap", () => {
  it("truncates history to the 100 most-recent records", async () => {
    // Seed with 99 existing records.
    const existing = Array.from({ length: 99 }, (_, i) => ({
      id: `d-${i + 1}`,
      app: "myapp",
      status: "success",
      commitBefore: "a",
      commitAfter: "b",
      durationMs: 1,
      triggeredBy: "ci",
      createdAt: new Date().toISOString(),
    }));
    await writeFile(join(tmpDir, ".relay-history.json"), JSON.stringify(existing));

    const { recordDeploy, getHistory } = await freshHistory();

    // Adding one more reaches exactly 100 — no truncation yet.
    await recordDeploy("myapp", { success: true, commitBefore: "b", commitAfter: "c", durationMs: 1 }, "ci");
    expect(await getHistory()).toHaveLength(100);

    // Need a fresh module load to avoid the cached records being 100 already.
    vi.resetModules();
    process.env.APPS_DIR = tmpDir; // keep same dir

    const mod2 = await import("./history.js");
    // Adding one more (101st) should cap at 100.
    await mod2.recordDeploy("myapp", { success: true, commitBefore: "c", commitAfter: "d", durationMs: 1 }, "ci");
    const list = await mod2.getHistory();
    expect(list).toHaveLength(100);
  });

  it("newest records are kept when truncation occurs (unshift + truncate)", async () => {
    // Seed with exactly 100 records in newest-first order (d-100 at index 0,
    // d-1 at index 99). The service always unshifts new records, so the file
    // is expected in that order. After adding one more (d-101), list.length=100
    // drops the last element (d-1).
    const existing = Array.from({ length: 100 }, (_, i) => ({
      id: `d-${100 - i}`, // d-100, d-99, ..., d-1
      app: "myapp",
      status: "success",
      commitBefore: "a",
      commitAfter: "b",
      durationMs: 1,
      triggeredBy: "ci",
      createdAt: new Date().toISOString(),
    }));
    await writeFile(join(tmpDir, ".relay-history.json"), JSON.stringify(existing));

    const { recordDeploy, getHistory } = await freshHistory();
    const newRecord = await recordDeploy("myapp", { success: true, commitBefore: "b", commitAfter: "newest", durationMs: 1 }, "ci");

    const list = await getHistory();
    expect(list).toHaveLength(100);
    // The newest record is at the front (unshift)
    expect(list[0]!.id).toBe(newRecord.id);
    expect(list[0]!.commitAfter).toBe("newest");
    // The oldest record (d-1) was dropped
    expect(list.find((r) => r.id === "d-1")).toBeUndefined();
  });
});

// ── app filter in getHistory ─────────────────────────────────────────────────

describe("getHistory app filter", () => {
  it("returns all records when no app filter is given", async () => {
    const { recordDeploy, getHistory } = await freshHistory();
    await recordDeploy("app-a", { success: true, commitBefore: "a", commitAfter: "b", durationMs: 1 }, "ci");
    await recordDeploy("app-b", { success: true, commitBefore: "a", commitAfter: "b", durationMs: 1 }, "ci");
    await recordDeploy("app-a", { success: false, commitBefore: "b", commitAfter: "b", durationMs: 1 }, "ci");

    const all = await getHistory();
    expect(all).toHaveLength(3);
  });

  it("filters records to matching app when app name is supplied", async () => {
    const { recordDeploy, getHistory } = await freshHistory();
    await recordDeploy("app-a", { success: true,  commitBefore: "a", commitAfter: "b", durationMs: 1 }, "ci");
    await recordDeploy("app-b", { success: true,  commitBefore: "a", commitAfter: "b", durationMs: 1 }, "ci");
    await recordDeploy("app-a", { success: false, commitBefore: "b", commitAfter: "b", durationMs: 1 }, "ci");

    const forA = await getHistory("app-a");
    expect(forA).toHaveLength(2);
    expect(forA.every((r) => r.app === "app-a")).toBe(true);

    const forB = await getHistory("app-b");
    expect(forB).toHaveLength(1);
    expect(forB[0]!.app).toBe("app-b");
  });

  it("returns empty array when app has no history", async () => {
    const { getHistory } = await freshHistory();
    const list = await getHistory("no-such-app");
    expect(list).toEqual([]);
  });
});

// ── recordDeploy return value ────────────────────────────────────────────────

describe("recordDeploy return value", () => {
  it("returns a record with all required fields", async () => {
    const { recordDeploy } = await freshHistory();
    const result = { success: true, commitBefore: "aaa", commitAfter: "bbb", durationMs: 42 };
    const record = await recordDeploy("myapp", result, "api");

    expect(record).toMatchObject({
      id: expect.stringMatching(/^d-\d+$/),
      app: "myapp",
      status: "success",
      commitBefore: "aaa",
      commitAfter: "bbb",
      durationMs: 42,
      triggeredBy: "api",
      createdAt: expect.any(String),
    });
  });

  it("sets status=failed when result.success is falsy", async () => {
    const { recordDeploy } = await freshHistory();
    const record = await recordDeploy("myapp", { success: false, commitBefore: "a", commitAfter: "a", durationMs: 0 }, "mcp");
    expect(record.status).toBe("failed");
  });
});
