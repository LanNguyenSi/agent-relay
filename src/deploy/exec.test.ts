/**
 * Tests for the process-spawn wrapper in src/deploy/exec.ts.
 * Runs against REAL child processes to verify:
 * - stdout/stderr capture
 * - exitCode mapping: numeric (N), success (0), string code→1 (ENOENT)
 */
import { describe, it, expect } from "vitest";
import { runExec, runShell } from "./exec.js";

const cwd = "/tmp";

describe("runExec — stdout/stderr capture", () => {
  it("captures stdout from a successful command", async () => {
    const result = await runExec("node", ["-e", "process.stdout.write('hello')"], cwd);
    expect(result.stdout).toBe("hello");
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("captures stderr from a command that writes to stderr", async () => {
    const result = await runExec("node", ["-e", "process.stderr.write('err-out')"], cwd);
    expect(result.stderr).toBe("err-out");
    expect(result.exitCode).toBe(0);
  });
});

describe("runExec — exitCode mapping", () => {
  it("returns exitCode=0 for a successful process", async () => {
    const result = await runExec("node", ["-e", ""], cwd);
    expect(result.exitCode).toBe(0);
  });

  it("returns the exact numeric exit code when process exits non-zero (code=2)", async () => {
    const result = await runExec("node", ["-e", "process.exit(2)"], cwd);
    expect(result.exitCode).toBe(2);
  });

  it("returns the exact numeric exit code for exit(127)", async () => {
    const result = await runExec("node", ["-e", "process.exit(127)"], cwd);
    expect(result.exitCode).toBe(127);
  });

  it("normalizes a string error code (ENOENT from nonexistent command) to exitCode=1", async () => {
    // When the binary itself doesn't exist, execFile's error has code='ENOENT' (string).
    // The normalization branch: typeof 'ENOENT' !== 'number' → exitCode = 1.
    const result = await runExec("__nonexistent_binary_xyz__", [], cwd);
    expect(result.exitCode).toBe(1);
  });
});

describe("runExec — both stdout and stderr", () => {
  it("captures both stdout and stderr from the same process", async () => {
    const result = await runExec(
      "node",
      ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
      cwd,
    );
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.exitCode).toBe(3);
  });
});

describe("runShell", () => {
  it("wraps a shell command string and returns result", async () => {
    // `printf`, not `echo -n`: whether a shell's `echo` builtin treats `-n`
    // as a flag or a literal argument is implementation/mode-dependent (e.g.
    // bash invoked as `sh` — which is what /bin/sh is on macOS — ignores
    // echo's options entirely in POSIX mode). `printf` has no such ambiguity
    // across `/bin/sh` implementations.
    const result = await runShell("printf hello", cwd);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
  });

  it("propagates non-zero exit code from shell command", async () => {
    const result = await runShell("exit 5", cwd);
    expect(result.exitCode).toBe(5);
  });
});

describe("runExec — configurable timeout and maxBuffer", () => {
  it("reports the default timeoutMs and no killReason for a normal call", async () => {
    const result = await runExec("node", ["-e", "process.exit(0)"], cwd);
    expect(result.timeoutMs).toBe(300_000);
    expect(result.killReason).toBeUndefined();
  });

  it("kills a long-running process once opts.timeoutMs elapses and reports killReason 'timeout'", async () => {
    const start = Date.now();
    const result = await runExec(
      "node",
      ["-e", "setTimeout(() => {}, 10000)"],
      cwd,
      { timeoutMs: 300 },
    );
    const elapsed = Date.now() - start;
    expect(result.killReason).toBe("timeout");
    expect(result.exitCode).toBe(1);
    expect(result.timeoutMs).toBe(300);
    expect(elapsed).toBeLessThan(5000);
  });

  it("kills a process that exceeds opts.maxBufferBytes and reports killReason 'maxbuffer'", async () => {
    const result = await runExec(
      "node",
      ["-e", "process.stdout.write('x'.repeat(200000))"],
      cwd,
      { maxBufferBytes: 1024 },
    );
    expect(result.killReason).toBe("maxbuffer");
    expect(result.exitCode).toBe(1);
  });

  it("runShell forwards opts through to runExec (timeout case)", async () => {
    const result = await runShell("sleep 10", cwd, { timeoutMs: 300 });
    expect(result.killReason).toBe("timeout");
    expect(result.exitCode).toBe(1);
    expect(result.timeoutMs).toBe(300);
  });
});
