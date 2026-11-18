/**
 * HTTP-layer test proving GET /system does not block the event loop while it
 * runs its `free`/`df` shell pipelines.
 *
 * This is a separate file from routes-extra.test.ts on purpose: that file's
 * `vi.mock("../deploy/exec.js")` is hoisted file-wide, so `runShell` cannot be
 * un-mocked for a single describe block there. Here nothing is mocked: the
 * real execFile-backed `runShell` runs stub `free` and `df` executables
 * created under `.ap-logs/` and prepended to PATH. Each stub sleeps 0.45 s
 * and prints real-format output. A setInterval heartbeat (every 5 ms) counts
 * event-loop turns while the request is pending, both in absolute terms and
 * relative to how long the request stayed pending: a synchronous execSync in
 * the handler blocks the thread, so the ticks that should have fired during
 * that window are missing and the ratio collapses (~0.5 when one of the two
 * calls blocks, ~0 when both do). The parsed JSON additionally proves the
 * stubs really ran (macOS has no `free`, and its real `df` output cannot
 * contain the stub values).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { api } from "./routes.js";
import { env } from "../config/env.js";

const AUTH = `Bearer ${env.AUTH_TOKEN}`;

const HEARTBEAT_MS = 5;
const STUB_SLEEP_S = "0.45";

let stubDir = "";
let previousPath: string | undefined;

function request(pathname: string) {
  return api.fetch(new Request(`http://test${pathname}`, {
    headers: { Authorization: AUTH },
  }));
}

beforeAll(() => {
  const logsRoot = path.join(process.cwd(), ".ap-logs");
  mkdirSync(logsRoot, { recursive: true });
  stubDir = mkdtempSync(path.join(logsRoot, "system-stub-bin-"));

  // `free -m` style: Mem row is "Mem: total used free shared buff/cache available",
  // so the handler's `awk '/Mem:/{printf "%d %d", $3, $2}'` sees total 4096, used 1024.
  writeFileSync(
    path.join(stubDir, "free"),
    `#!/bin/sh\nsleep ${STUB_SLEEP_S}\necho 'Mem:  4096 1024 2000 10 800 2900'\n`,
  );
  // `df -h /` style: header line, then the device line NR==2 with fields
  // fs size used avail capacity mount, so `awk 'NR==2{...}'` sees used 50Gi, size 228Gi, capacity 25%.
  writeFileSync(
    path.join(stubDir, "df"),
    `#!/bin/sh\nsleep ${STUB_SLEEP_S}\necho 'Filesystem Size Used Avail Capacity Mounted on'\necho '/dev/stub 228Gi 50Gi 150Gi 25% /'\n`,
  );
  chmodSync(path.join(stubDir, "free"), 0o755);
  chmodSync(path.join(stubDir, "df"), 0o755);

  previousPath = process.env.PATH;
  process.env.PATH = `${stubDir}:${previousPath ?? ""}`;
});

afterAll(() => {
  if (previousPath !== undefined) process.env.PATH = previousPath;
  rmSync(stubDir, { recursive: true, force: true });
});

describe("GET /api/system event-loop non-blocking (real runShell, stub executables)", () => {
  it("keeps the event loop turning while both shell measurements sleep", async () => {
    // Calibrate the heartbeat's real period on this machine right before
    // measuring (short timers coalesce well above their nominal 5-10 ms),
    // then require that at least 70% of the ticks the calibration period
    // predicts for the pending window actually fired. Both children sleep
    // ~450 ms; with one measurement made synchronous (execSync) its sleep
    // blocks the thread and its share of ticks is missing (~0.5 ratio); with
    // both synchronous the ratio drops to ~0.
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, HEARTBEAT_MS);
    try {
      const calibrationStart = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 150));
      const msPerTick = (performance.now() - calibrationStart) / ticks;
      ticks = 0;

      const startedAt = performance.now();
      const res = await request("/system");
      const elapsedMs = performance.now() - startedAt;

      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        memory: { usedMb: number; totalMb: number };
        disk: { used: string; total: string; percent: string };
      };
      // Values only exist if the PATH-stubbed free/df actually ran and were parsed.
      expect(body.memory.usedMb).toBe(1024);
      expect(body.memory.totalMb).toBe(4096);
      expect(body.disk.used).toBe("50Gi");
      expect(body.disk.total).toBe("228Gi");
      expect(body.disk.percent).toBe("25%");

      expect(ticks).toBeGreaterThanOrEqual(20);
      expect(ticks).toBeGreaterThanOrEqual(Math.floor((elapsedMs / msPerTick) * 0.7));
    } finally {
      clearInterval(heartbeat);
    }
  });
});
