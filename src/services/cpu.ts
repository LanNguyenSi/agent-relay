/**
 * Host CPU usage from /proc/stat.
 *
 * The runtime image is Alpine (BusyBox), whose `top` prints no `Cpu(s)` line,
 * so shelling out to procps-style `top` always yielded 0. /proc/stat exists on
 * every Linux kernel, so usage is computed from the delta between two samples.
 */
import { readFile } from "node:fs/promises";

export interface CpuSample {
  /** Sum of all time columns that count towards the total (user..steal). */
  total: number;
  /** idle + iowait. */
  idle: number;
}

/**
 * Parse the aggregate `cpu` line of /proc/stat. Columns are
 * user nice system idle iowait irq softirq steal guest guest_nice; guest time
 * is already included in user/nice, so only the first eight columns are
 * summed. Returns null when no aggregate line with numeric columns exists.
 */
export function parseProcStat(contents: string): CpuSample | null {
  const line = contents.split("\n").find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const cols = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (cols.length < 4 || cols.some((n) => !Number.isFinite(n))) return null;
  const total = cols.reduce((a, b) => a + b, 0);
  const idle = (cols[3] ?? 0) + (cols[4] ?? 0);
  return { total, idle };
}

/** Busy percentage (0-100, one decimal) between two samples; 0 when no time elapsed. */
export function cpuUsageBetween(a: CpuSample, b: CpuSample): number {
  const totalDelta = b.total - a.total;
  const idleDelta = b.idle - a.idle;
  if (totalDelta <= 0) return 0;
  const busy = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, busy)) * 10) / 10;
}

const SAMPLE_INTERVAL_MS = 200;

async function readSample(): Promise<CpuSample | null> {
  return parseProcStat(await readFile("/proc/stat", "utf8"));
}

/** Sample /proc/stat twice and return the busy percentage; 0 when unreadable. */
export async function readCpuUsage(intervalMs: number = SAMPLE_INTERVAL_MS): Promise<number> {
  try {
    const first = await readSample();
    if (!first) return 0;
    await new Promise((r) => setTimeout(r, intervalMs));
    const second = await readSample();
    if (!second) return 0;
    return cpuUsageBetween(first, second);
  } catch {
    return 0;
  }
}
