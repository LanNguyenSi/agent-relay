import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runExec(
  command: string,
  args: string[],
  cwd: string,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: 300_000 }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? "",
        stderr: stderr?.toString() ?? "",
        exitCode: error?.code !== undefined ? (typeof error.code === "number" ? error.code : 1) : 0,
      });
    });
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
export async function runShell(command: string, cwd: string): Promise<ExecResult> {
  return runExec("/bin/sh", ["-c", command], cwd);
}
