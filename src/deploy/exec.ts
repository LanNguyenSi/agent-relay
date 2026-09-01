import { execFile } from "node:child_process";

/** Default per-step timeout, in milliseconds. Overridable via `.relay.yml`'s
 * `step_timeout_seconds` (see src/config/relay.ts) and passed through
 * `ExecOptions.timeoutMs`. */
export const DEFAULT_STEP_TIMEOUT_MS = 300_000;

/** Default cap on stdout/stderr buffering, applied per stream (stdout and
 * stderr each get their own budget) before execFile kills the child process
 * with ERR_CHILD_PROCESS_STDIO_MAXBUFFER. Node's own default is 1 MB, which
 * is too easy for a chatty build to hit; 16 MiB per stream gives real
 * headroom while still bounding memory use. The combined step output stored
 * on a DeployStep is capped separately (see STEP_OUTPUT_MAX_CHARS in
 * engine.ts). */
export const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export interface ExecOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /**
   * The effective timeout, in milliseconds, used for this call. Always set
   * by runExec/runShell; optional on the type only so unrelated call sites
   * that build an ExecResult-shaped literal by hand (e.g. mocked test
   * fixtures in files outside this task's scope) keep compiling.
   */
  timeoutMs?: number;
  /**
   * The effective per-stream maxBuffer, in bytes, used for this call.
   * Always set by runExec/runShell, same reasoning as timeoutMs above.
   */
  maxBufferBytes?: number;
  /** Set when the process was killed by execFile rather than exiting on its
   * own. Absent when the process exited normally (whatever the exit code). */
  killReason?: "timeout" | "maxbuffer";
}

export function runExec(
  command: string,
  args: string[],
  cwd: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const maxBufferBytes = opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: maxBufferBytes },
      (error, stdout, stderr) => {
        let killReason: "timeout" | "maxbuffer" | undefined;
        if (error) {
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            killReason = "maxbuffer";
          } else if (error.killed === true && error.code == null) {
            killReason = "timeout";
          }
        }
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          exitCode: error?.code !== undefined ? (typeof error.code === "number" ? error.code : 1) : 0,
          timeoutMs,
          maxBufferBytes,
          ...(killReason ? { killReason } : {}),
        });
      },
    );
  });
}

/**
 * Trust boundary: runShell executes an arbitrary shell command string via
 * /bin/sh -c. Only call this for values that originate from .relay.yml fields
 * that are under operator control (pre_update, post_update, command). Operators
 * who have push access to .relay.yml are trusted to supply these values; they
 * are NOT safe for any user-supplied or network-derived input. All docker and
 * git invocations that accept external data must use runExec with an arg array
 * instead.
 */
export async function runShell(
  command: string,
  cwd: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  return runExec("/bin/sh", ["-c", command], cwd, opts);
}
