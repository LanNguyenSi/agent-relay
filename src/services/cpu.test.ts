import { describe, it, expect, vi, afterEach } from "vitest";

const readFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:fs/promises", async (orig) => ({
  ...(await orig<typeof import("node:fs/promises")>()),
  readFile: readFileMock,
}));

import { parseProcStat, cpuUsageBetween, readCpuUsage } from "./cpu.js";

const STAT_A = [
  "cpu  100 0 100 700 100 0 0 0 0 0",
  "cpu0 50 0 50 350 50 0 0 0 0 0",
  "intr 12345",
].join("\n");
const STAT_B = [
  "cpu  250 0 150 750 150 0 0 0 0 0",
  "cpu0 125 0 75 375 75 0 0 0 0 0",
].join("\n");

describe("parseProcStat", () => {
  it("reads the aggregate cpu line, not the per-core lines", () => {
    expect(parseProcStat(STAT_A)).toEqual({ total: 1000, idle: 800 });
  });

  it("does not double count guest columns", () => {
    const s = "cpu  10 0 10 70 10 0 0 0 500 500\n";
    expect(parseProcStat(s)).toEqual({ total: 100, idle: 80 });
  });

  it("returns null for missing or malformed input", () => {
    expect(parseProcStat("")).toBeNull();
    expect(parseProcStat("cpu0 1 2 3 4\n")).toBeNull();
    expect(parseProcStat("cpu  a b c d\n")).toBeNull();
    expect(parseProcStat("cpu  1 2\n")).toBeNull();
  });
});

describe("cpuUsageBetween", () => {
  it("computes the busy share of the delta", () => {
    const a = parseProcStat(STAT_A)!;
    const b = parseProcStat(STAT_B)!;
    // total delta 300, idle delta 100 -> 66.7% busy
    expect(cpuUsageBetween(a, b)).toBe(66.7);
  });

  it("is 0 when no time elapsed and clamps to 0..100", () => {
    expect(cpuUsageBetween({ total: 5, idle: 1 }, { total: 5, idle: 1 })).toBe(0);
    expect(cpuUsageBetween({ total: 0, idle: 0 }, { total: 10, idle: 0 })).toBe(100);
    expect(cpuUsageBetween({ total: 0, idle: 0 }, { total: 10, idle: 20 })).toBe(0);
  });
});

describe("readCpuUsage", () => {
  afterEach(() => readFileMock.mockReset());

  it("returns a non-zero value from two /proc/stat samples", async () => {
    readFileMock.mockResolvedValueOnce(STAT_A).mockResolvedValueOnce(STAT_B);
    expect(await readCpuUsage(0)).toBe(66.7);
  });

  it("returns 0 when /proc/stat is unreadable", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"));
    expect(await readCpuUsage(0)).toBe(0);
  });
});
