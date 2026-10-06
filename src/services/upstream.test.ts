import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

vi.mock("../deploy/exec.js", () => ({ runExec: vi.fn(), runShell: vi.fn() }));
vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return { ...actual, loadRelayConfig: vi.fn() };
});

import { runExec } from "../deploy/exec.js";
import { loadRelayConfig } from "../config/relay.js";
import { env } from "../config/env.js";
import { getUpstream, clearUpstreamCache, upstreamTuning } from "./upstream.js";
import { listApps, getAppDetail } from "./apps.js";

const mockRunExec = vi.mocked(runExec);
const A = "a".repeat(40);
const B = "b".repeat(40);
const defaults = { ...upstreamTuning };

type Git = { branch?: string; head?: string; remote?: { stdout?: string; stderr?: string; exitCode?: number; killReason?: "timeout" }; delayMs?: number };

function stubGit(g: Git = {}) {
  const calls: string[][] = [];
  mockRunExec.mockImplementation(async (cmd, args) => {
    calls.push([cmd, ...args]);
    const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0 });
    if (args[0] === "rev-parse" && args[1] === "--abbrev-ref") return ok((g.branch ?? "main") + "\n");
    if (args[0] === "rev-parse" && args[1] === "--short") return ok("abc1234\n");
    if (args[0] === "rev-parse") return ok((g.head ?? A) + "\n");
    if (args[0] === "ls-remote") {
      if (g.delayMs) await new Promise((r) => setTimeout(r, g.delayMs));
      const r = g.remote ?? { stdout: `${A}\trefs/heads/${g.branch ?? "main"}\n` };
      return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.exitCode ?? 0, ...(r.killReason ? { killReason: r.killReason } : {}) };
    }
    return ok("");
  });
  return calls;
}

beforeEach(() => {
  clearUpstreamCache();
  Object.assign(upstreamTuning, defaults);
  mockRunExec.mockReset();
});
afterEach(() => vi.useRealTimers());

// The shipped defaults are documented in docs/integration.md and CHANGELOG;
// pin them so code and docs cannot drift apart.
describe("upstream tuning defaults", () => {
  it("ships the documented TTL, timeouts, concurrency and budgets", () => {
    expect(defaults).toMatchObject({
      cacheTtlMs: 60_000,
      lsRemoteTimeoutMs: 5_000,
      maxConcurrentLsRemote: 4,
      listBudgetMs: 6_000,
      detailBudgetMs: 3_000,
    });
  });
});

describe("getUpstream state decision", () => {
  it("is current when the remote head equals the deployed commit", async () => {
    stubGit();
    const u = await getUpstream("/apps/x");
    expect(u).toMatchObject({ branch: "main", deployedCommit: A, remoteHead: A, state: "current" });
    expect(u.reason).toBeUndefined();
    expect(u.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it("is behind when the remote head differs from the deployed commit", async () => {
    stubGit({ remote: { stdout: `${B}\trefs/heads/main\n` } });
    const u = await getUpstream("/apps/x");
    expect(u).toMatchObject({ state: "behind", deployedCommit: A, remoteHead: B });
  });

  it("is unknown (not current) when ls-remote fails", async () => {
    stubGit({ remote: { exitCode: 128, stderr: "fatal: could not read from remote\n" } });
    const u = await getUpstream("/apps/x");
    expect(u.state).toBe("unknown");
    expect(u.remoteHead).toBeNull();
    expect(u.reason).toMatch(/ls-remote failed \(exit 128\).*could not read/);
  });

  it("is unknown when ls-remote times out", async () => {
    stubGit({ remote: { exitCode: 1, killReason: "timeout" } });
    const u = await getUpstream("/apps/x");
    expect(u.state).toBe("unknown");
    expect(u.reason).toMatch(/timed out/);
  });

  it("is unknown when the branch is missing on the remote", async () => {
    stubGit({ remote: { stdout: "" } });
    const u = await getUpstream("/apps/x");
    expect(u.state).toBe("unknown");
    expect(u.reason).toMatch(/not found on remote/);
  });

  it("does not accept a different ref that merely ends with the branch name", async () => {
    stubGit({ remote: { stdout: `${A}\trefs/heads/feature/main\n` } });
    expect((await getUpstream("/apps/x")).state).toBe("unknown");
  });

  it("is unknown on a detached HEAD", async () => {
    stubGit({ branch: "HEAD" });
    const u = await getUpstream("/apps/x");
    expect(u).toMatchObject({ state: "unknown", branch: null });
    expect(u.reason).toMatch(/detached/);
  });

  it("is unknown when the deployed commit cannot be read", async () => {
    stubGit({ head: "" });
    const u = await getUpstream("/apps/x");
    expect(u).toMatchObject({ state: "unknown", deployedCommit: null });
  });

  it("is unknown when rev-parse HEAD does not print a full 40-hex sha", async () => {
    const calls = stubGit({ head: "not-a-sha" });
    const u = await getUpstream("/apps/x");
    expect(u).toMatchObject({ state: "unknown", deployedCommit: null });
    expect(u.reason).toMatch(/deployed commit/);
    expect(calls.filter((c) => c[1] === "ls-remote")).toHaveLength(0);
  });

  it("uses the checkout branch, not a fixed main", async () => {
    const calls = stubGit({ branch: "release/1.x" });
    await getUpstream("/apps/x");
    expect(calls).toContainEqual(["git", "ls-remote", "origin", "refs/heads/release/1.x"]);
  });
});

describe("getUpstream is read-only and cached", () => {
  it("only runs rev-parse and ls-remote, never fetch/pull/checkout/reset", async () => {
    const calls = stubGit();
    await getUpstream("/apps/x");
    const subcommands = new Set(calls.map((c) => c[1]));
    expect([...subcommands].sort()).toEqual(["ls-remote", "rev-parse"]);
    expect(calls.flat()).not.toContain("fetch");
    expect(calls.flat()).not.toContain("pull");
  });

  it("passes a bounded timeout to ls-remote", async () => {
    stubGit();
    await getUpstream("/apps/x");
    const ls = mockRunExec.mock.calls.find((c) => c[1][0] === "ls-remote")!;
    expect(ls[3]).toEqual({ timeoutMs: 5_000 });
  });

  it("reuses the ls-remote result within the TTL and refreshes after it", async () => {
    vi.useFakeTimers();
    const calls = stubGit();
    const count = () => calls.filter((c) => c[1] === "ls-remote").length;
    await getUpstream("/apps/x");
    await getUpstream("/apps/x");
    expect(count()).toBe(1);
    vi.advanceTimersByTime(upstreamTuning.cacheTtlMs - 1);
    await getUpstream("/apps/x");
    expect(count()).toBe(1);
    vi.advanceTimersByTime(2);
    await getUpstream("/apps/x");
    expect(count()).toBe(2);
  });

  it("re-reads the deployed commit on every call so a deploy shows at once", async () => {
    stubGit();
    expect((await getUpstream("/apps/x")).state).toBe("current");
    stubGit({ head: B });
    expect((await getUpstream("/apps/x")).state).toBe("behind");
  });

  it("runs exactly one ls-remote for concurrent lookups of one app while the first is pending", async () => {
    const calls = stubGit({ delayMs: 50 });
    const results = await Promise.all([getUpstream("/apps/x"), getUpstream("/apps/x"), getUpstream("/apps/x")]);
    expect(results.map((r) => r.state)).toEqual(["current", "current", "current"]);
    expect(calls.filter((c) => c[1] === "ls-remote")).toHaveLength(1);
  });

  it("looks up the new branch after a branch switch within the TTL", async () => {
    stubGit({ branch: "main" });
    await getUpstream("/apps/x");
    const calls = stubGit({ branch: "release" });
    const u = await getUpstream("/apps/x");
    expect(u.branch).toBe("release");
    expect(calls).toContainEqual(["git", "ls-remote", "origin", "refs/heads/release"]);
  });

  it("caches a failed lookup too, so a dead remote is not re-probed per request", async () => {
    const calls = stubGit({ remote: { exitCode: 128 } });
    await getUpstream("/apps/x");
    await getUpstream("/apps/x");
    expect(calls.filter((c) => c[1] === "ls-remote")).toHaveLength(1);
  });
});

describe("listApps upstream", () => {
  let root: string;
  const origDir = env.APPS_DIR;
  beforeEach(async () => {
    root = await mkdtemp(resolve(tmpdir(), "upstream-list-"));
    for (let i = 0; i < 12; i++) await mkdir(resolve(root, `app${i}`));
    (env as { APPS_DIR: string }).APPS_DIR = root;
    vi.mocked(loadRelayConfig).mockResolvedValue({ name: "x", health: "/h" } as never);
  });
  afterEach(async () => {
    (env as { APPS_DIR: string }).APPS_DIR = origDir;
    await rm(root, { recursive: true, force: true });
  });

  it("includes upstream on each configured app", async () => {
    stubGit();
    const apps = await listApps();
    expect(apps).toHaveLength(12);
    expect(apps[0]).toMatchObject({ configured: true, commit: "abc1234", upstream: { state: "current" } });
  });

  it("stays within the list budget when git ls-remote is slow", async () => {
    upstreamTuning.listBudgetMs = 100;
    stubGit({ delayMs: 1500 });
    const t0 = Date.now();
    const apps = await listApps();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(900);
    expect(apps).toHaveLength(12);
    for (const a of apps) {
      expect(a.upstream?.state).toBe("unknown");
      expect(a.upstream?.reason).toMatch(/pending/);
    }
  });

  it("never runs more than the concurrency bound of ls-remote calls at once", async () => {
    upstreamTuning.maxConcurrentLsRemote = 3;
    upstreamTuning.listBudgetMs = 5_000;
    let running = 0;
    let peak = 0;
    stubGit();
    const base = mockRunExec.getMockImplementation()!;
    mockRunExec.mockImplementation(async (cmd, args, cwd, o) => {
      if (args[0] !== "ls-remote") return base(cmd, args, cwd, o);
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running--;
      return { stdout: `${A}\trefs/heads/main\n`, stderr: "", exitCode: 0 };
    });
    await listApps();
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it("getAppDetail carries upstream in the contract shape", async () => {
    stubGit();
    vi.mocked(loadRelayConfig).mockResolvedValue({ name: "x", health: "/h", compose_file: "docker-compose.yml" } as never);
    const d = await getAppDetail("app0");
    expect(d.upstream).toEqual({
      branch: "main",
      deployedCommit: A,
      remoteHead: A,
      checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      state: "current",
    });
  });

  it("getAppDetail does not wait for a slow or dead remote beyond the detail budget", async () => {
    upstreamTuning.detailBudgetMs = 100;
    stubGit({ delayMs: 1500 });
    vi.mocked(loadRelayConfig).mockResolvedValue({ name: "x", health: "/h", compose_file: "docker-compose.yml" } as never);
    const t0 = Date.now();
    const d = await getAppDetail("app0");
    expect(Date.now() - t0).toBeLessThan(900);
    expect(d.upstream).toMatchObject({ state: "unknown" });
    expect(d.upstream.reason).toMatch(/pending/);
  });

  it("getAppDetail is not held up by a full ls-remote queue", async () => {
    upstreamTuning.detailBudgetMs = 100;
    upstreamTuning.maxConcurrentLsRemote = 1;
    stubGit({ delayMs: 1500 });
    vi.mocked(loadRelayConfig).mockResolvedValue({ name: "x", health: "/h", compose_file: "docker-compose.yml" } as never);
    void listApps();
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    const d = await getAppDetail("app0");
    expect(Date.now() - t0).toBeLessThan(900);
    expect(d.upstream.state).toBe("unknown");
  });
});
